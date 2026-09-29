/**
 * RejectionSweep_cld.gs - marks rejected job applications in the Jobs sheet, straight from Gmail.
 *
 * Lives inside the "Jobs" spreadsheet (Extensions > Apps Script) and runs on Google's servers
 * three times a day (5am, 12pm, 8pm Pacific; Google fires each within that hour).
 * No laptop, no service-account key, no Claude session. Gmail access is read-only.
 *
 * Each run:
 *   1. Gmail search, last 2 days, rejection wording, sent mail excluded.
 *   2. Drops messages already handled, job alerts / newsletters, and anything without a clear
 *      rejection phrase in the subject or body.
 *   3. Matches each rejection to ONE Tracking row: company name variants plus the careers-site
 *      slug in the posting URL; when a company has several rows, the requisition number, then
 *      role-title overlap.
 *   4. Writes Status (F) = "Rejected M/D/YYYY" and prepends "REJECTED M/D/YYYY - <subject>" to
 *      Comments (G), after re-checking the row still holds that posting URL.
 *   5. Logs every rejection it saw to the "Rejection Log" tab: UPDATED, AMBIGUOUS, UNMATCHED,
 *      ALREADY REJECTED. Ambiguous and unmatched ones are never written - decide those by hand.
 *
 * Functions to run by hand from the editor:
 *   installTriggers()  once - creates the three daily triggers (safe to re-run).
 *   backfillPreview()  last 30 days, writes nothing to Tracking, logs "DRY RUN" lines to review.
 *   backfill()         last 30 days, for real.
 */

const CFG = {
  TAB: 'Tracking',
  LOG_TAB: 'Rejection Log',
  TZ: 'America/Los_Angeles',
  ME: Session.getActiveUser().getEmail(),
  RUN_HOURS: [5, 12, 20],
  LOOKBACK_HOURS: 2,
  BACKFILL_DAYS: 30,
  MAX_MESSAGES: 300,
  SKIP_KEY: 'skippedMessageIds',
  SKIP_CAP: 400, // Script Properties values are capped at 9 KB
};

const QUERY = '-in:sent -in:chats (unfortunately OR "regret to inform" OR "not to move forward" OR ' +
  '"not moving forward" OR "move forward with other" OR "other candidates" OR "decided to pursue" OR ' +
  '"after careful consideration" OR "no longer under consideration" OR "position has been filled" OR ' +
  '"not be moving forward" OR "not been selected" OR "will not be proceeding")';

const REJECT_RE = new RegExp([
  'unfortunately', 'regret to inform', 'not to move forward', 'not moving forward',
  'move forward with other', 'pursue other candidates', 'other candidates whose',
  'decided to pursue', 'no longer under consideration', 'position has been filled',
  'not be moving forward', 'not been selected', 'will not be proceeding',
  "won't be moving forward", 'will not be moving forward', 'decided not to proceed',
].join('|'), 'i');

// A rejection must also look job-related, so personal mail that happens to say "unfortunately" never counts.
const JOB_CONTEXT_RE = /(application|applied|applying|candida|position|role|opportunit|interview|recruit|talent|career|hiring|\bjobs?\b|workday|greenhouse|ashby|lever\.co|icims|smartrecruiters|teamtailor|successfactors|taleo|jobvite)/i;
const BODY_JOB_RE = /(your application|for applying|to apply for|the position|this position|the role|this role|your candidacy)/i;
// Three-letter words kept for titles (pmo, erp, avp, fpa); these three-letter words are not.
const STOP3 = new Set(['the', 'and', 'for', 'you', 'our', 'are', 'has', 'was', 'its', 'inc', 'llc', 'com', 'www', 'job', 'new', 'usa', 'all', 'any', 'not', 'but', 'can', 'who', 'may']);
const keepWord_ = w => (w.length >= 4 || (w.length === 3 && !STOP3.has(w))) && !/^\d+$/.test(w);
const URL_NOISE = new Set(['jobs', 'job', 'careers', 'career', 'apply', 'details', 'posting', 'requisition',
  'remote', 'hybrid', 'onsite', 'united', 'states']);

const NOT_REJECTION_SUBJECT_RE = /(job alert|jobs? for you|new jobs|recommended jobs|jobs you may|is hiring|hiring now|digest|newsletter|webinar|invitation to interview|interview (invitation|request|confirmation)|schedule (an|your) interview)/i;
const NOT_REJECTION_FROM_RE = /(jobalerts|job-alerts|alerts@|newsletter|digest|marketing|glassdoor|indeed\.com|ziprecruiter|dice\.com|builtin)/i;

const CORP_SUFFIX = ['inc', 'llc', 'ltd', 'corp', 'corporation', 'company', 'co', 'group', 'holdings',
  'partners', 'laboratories', 'labs', 'industries', 'international', 'technology', 'technologies',
  'systems', 'services', 'solutions', 'management', 'global'];
// First words too common to stand alone as a company token ("Applied Intuition" must not match "you applied").
const WEAK_WORD = new Set(['the', 'first', 'general', 'united', 'national', 'pacific', 'american',
  'michael', 'morgan', 'global', 'new', 'north', 'south', 'west', 'east', 'bank', 'capital', 'data',
  'applied', 'advanced', 'digital', 'smart', 'open', 'summit', 'premier', 'future', 'modern', 'public',
  'private', 'central', 'western', 'eastern', 'northern', 'southern', 'golden', 'royal', 'prime', 'blue']);
// Hiring-platform domains that say nothing about the employer.
const PLATFORM_RE = /^(myworkdayjobs|myworkday|icims|taleo|oraclecloud|successfactors|ultipro|paylocity|adp|applytojob|recruitee|eightfold|phenompeople|jobs2web|avature|workforcenow|dayforcehcm|brassring|kenexa|tcsapps|greenhouse|ashbyhq|lever|workable|smartrecruiters|jobvite|breezy|bamboohr|rippling|linkedin|indeed)$/i;
const GENERIC_HOST = new Set(['www', 'jobs', 'careers', 'career', 'job-boards', 'boards', 'apply',
  'app', 'hire', 'recruiting', 'talent', 'join', 'ibegin']);
const ATS_HOST_RE = /(greenhouse\.io|ashbyhq\.com|lever\.co|workable\.com|smartrecruiters\.com|jobvite\.com|breezy\.hr|bamboohr\.com|rippling\.com)$/i;
const ROLE_NOISE = new Set(['senior', 'director', 'manager', 'head', 'lead', 'principal', 'staff',
  'vice', 'president', 'applied', 'submitted', 'cold', 'referral', 'greenhouse', 'workday', 'ashby',
  'remote', 'hybrid', 'with', 'from', 'this', 'that', 'role', 'position', 'team']);
const LOG_HEADER = ['Logged (PT)', 'Outcome', 'Email date', 'From', 'Subject', 'Company',
  'Posting URL', 'Detail', 'Gmail message id'];

// ---------------------------------------------------------------- entry points

function scheduledSweep() { sweep_(CFG.LOOKBACK_HOURS + 'h', false); }
function backfillPreview() { sweep_(CFG.BACKFILL_DAYS + 'd', true); }
function backfill() { sweep_(CFG.BACKFILL_DAYS + 'd', false); }

function installTriggers() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'scheduledSweep')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('scheduledSweep')
    .timeBased().everyHours(1).create();
  logSheet_(SpreadsheetApp.getActive());
  Logger.log('Installed scheduledSweep every 1 hour');
}

// ---------------------------------------------------------------- the sweep

function sweep_(timeStr, dryRun) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    const ss = SpreadsheetApp.getActive();
    const sheet = ss.getSheetByName(CFG.TAB);
    const log = logSheet_(ss);
    const handled = handledIds_(log);
    const skipped = loadSkipped_();
    const rows = trackedRows_(sheet);
    const out = [];
    const newlySkipped = [];

    listMessages_(QUERY + ' newer_than:' + timeStr).forEach(id => {
      if (handled.has(id) || skipped.has(id)) return;
      const m = readMessage_(id);
      if (!m) return;
      if (m.from.toLowerCase().indexOf(CFG.ME) >= 0 || !isRejection_(m)) { newlySkipped.push(id); return; }

      const res = match_(m, rows);
      // Unmatched mail is only worth logging if the sender or subject is clearly about a job.
      if (res.outcome === 'UNMATCHED' && !JOB_CONTEXT_RE.test(m.from + ' ' + m.subject)) { newlySkipped.push(id); return; }
      let outcome = res.outcome;
      if (outcome === 'MATCHED') {
        if (/reject/i.test(res.row.status)) outcome = 'ALREADY REJECTED';
        else if (dryRun) outcome = 'DRY RUN - would update';
        else outcome = writeRejection_(sheet, res.row, m) ? 'UPDATED' : 'WRITE FAILED';
      } else if (dryRun) {
        outcome = 'DRY RUN - ' + outcome;
      }
      out.push([now_(), outcome, m.date, m.from, m.subject,
        res.row ? res.row.company : '', res.row ? res.row.url : '', res.detail, id]);
    });

    if (out.length) {
      log.insertRowsAfter(1, out.length);
      log.getRange(2, 1, out.length, LOG_HEADER.length).setValues(out);
    }
    if (!dryRun && newlySkipped.length) saveSkipped_(skipped, newlySkipped);
  } finally {
    lock.releaseLock();
  }
}

function isRejection_(m) {
  if (NOT_REJECTION_FROM_RE.test(m.from) || NOT_REJECTION_SUBJECT_RE.test(m.subject)) return false;
  if (!REJECT_RE.test(m.subject + '\n' + m.body)) return false;
  return JOB_CONTEXT_RE.test(m.from + ' ' + m.subject) || BODY_JOB_RE.test(m.body);
}

function match_(m, rows) {
  const text = ' ' + norm_(m.from + ' ' + m.subject + ' ' + m.body) + ' ';
  const domain = ((m.from.match(/@([^>\s]+)/) || ['', ''])[1] || '').toLowerCase();
  const hits = rows.filter(r => r.tokens.some(tok => hit_(tok, text, domain)));
  if (!hits.length) return { outcome: 'UNMATCHED', detail: 'no tracked company found in the email' };
  if (hits.length === 1) return { outcome: 'MATCHED', row: hits[0], detail: 'only row for this company' };

  const raw = (m.subject + ' ' + m.body).replace(/\bR-(\d)/gi, 'R$1').toUpperCase();
  const byReq = hits.filter(r => r.reqIds.some(id => raw.indexOf(id) >= 0));
  if (byReq.length === 1) return { outcome: 'MATCHED', row: byReq[0], detail: 'requisition number' };

  // Score role titles on the words that tell the candidate rows apart (drop words every row shares,
  // e.g. the city in every posting URL at one company).
  const words = new Set(norm_(m.subject + ' ' + m.body).split(' '));
  const shared = hits.slice(1).reduce((acc, r) => acc.filter(w => r.roleWords.indexOf(w) >= 0), hits[0].roleWords);
  const scored = hits.map(r => {
    const own = r.roleWords.filter(w => shared.indexOf(w) < 0);
    return { r: r, s: own.length ? own.filter(w => words.has(w)).length / own.length : 0 };
  }).sort((a, b) => b.s - a.s);
  const gap = scored[0].s - (scored[1] ? scored[1].s : 0);
  if (scored[0].s >= 0.6 && gap >= 0.2) {
    return { outcome: 'MATCHED', row: scored[0].r, detail: 'role title overlap ' + Math.round(scored[0].s * 100) + '%' };
  }
  return { outcome: 'AMBIGUOUS', detail: hits.length + ' candidate rows: ' + hits.map(r => r.url).join(' ; ') };
}

function hit_(tok, text, domain) {
  if (tok.length < 4) return domain.split(/[.@]/).indexOf(tok) >= 0; // short names: sender domain only
  return text.indexOf(' ' + tok + ' ') >= 0;
}

function writeRejection_(sheet, row, m) {
  const last = sheet.getLastRow();
  const urls = sheet.getRange(2, 2, last - 1, 1).getDisplayValues().map(r => normUrl_(r[0]));
  const i = urls.indexOf(normUrl_(row.url));
  if (i < 0) return false;
  const r = i + 2;
  if (normUrl_(sheet.getRange(r, 2).getDisplayValue()) !== normUrl_(row.url)) return false; // row moved
  const g = String(sheet.getRange(r, 7).getValue());
  sheet.getRange(r, 6).setValue('Rejected ' + m.date);
  sheet.getRange(r, 7).setValue(('REJECTED ' + m.date + ' - ' + m.subject + ' | ' + g).slice(0, 49000));
  SpreadsheetApp.flush();
  return String(sheet.getRange(r, 6).getDisplayValue()).indexOf('Rejected') === 0;
}

// ---------------------------------------------------------------- Tracking rows

function trackedRows_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const rows = [];
  sheet.getRange(2, 1, last - 1, 10).getDisplayValues().forEach(r => {
    const url = String(r[1]).trim();
    const status = String(r[5]);
    const s = status.toLowerCase();
    const applied = s.indexOf('applied') >= 0 && s.indexOf('not applied') < 0;
    if (!/^https?:\/\//i.test(url) || (!applied && s.indexOf('reject') < 0)) return;
    const company = String(r[9]).trim();
    const comments = String(r[6]);
    rows.push({
      url: url, status: status, company: company,
      tokens: companyTokens_(company, url),
      reqIds: reqIds_(url + ' ' + comments.slice(0, 400)),
      roleWords: roleWords_(comments, url, company),
    });
  });
  return rows;
}

function companyTokens_(company, url) {
  const t = new Set();
  const add = s => {
    const n = norm_(s);
    if (!n || (n.indexOf(' ') < 0 && WEAK_WORD.has(n))) return; // never a lone common word
    t.add(n);
  };
  const base = company.replace(/\(.*?\)/g, ' ');
  const inner = (company.match(/\(([^)]*)\)/g) || []).map(x => x.slice(1, -1));
  [base].concat(inner.join(',').split(/,|\s-\s/)).forEach(v => {
    const n = norm_(v);
    if (!n) return;
    add(n);
    let words = n.split(' ');
    while (words.length > 1 && CORP_SUFFIX.indexOf(words[words.length - 1]) >= 0) words = words.slice(0, -1);
    add(words.join(' '));
    const lead = words[0] === 'the' && words.length > 1 ? 1 : 0; // "The Fedcap Group" -> "fedcap"
    if (!WEAK_WORD.has(words[lead]) && words[lead].length >= 5) add(words[lead]);
  });
  const m = url.match(/^https?:\/\/([^\/?#]+)([^?#]*)/i);
  if (m) {
    const host = m[1].toLowerCase();
    const labels = host.split('.');
    const path = m[2].split('/').filter(Boolean);
    if (ATS_HOST_RE.test(host)) {
      if (path[0]) add(path[0].replace(/[-_]/g, ' '));             // greenhouse.io/faire -> "faire"
    } else {
      const first = labels[0];                                       // crowdstrike.wd5.myworkdayjobs.com
      if (!GENERIC_HOST.has(first) && !PLATFORM_RE.test(first)) add(first);
      const sld = labels.length >= 2 ? labels[labels.length - 2] : ''; // careers.ey.com -> "ey"
      if (sld && !GENERIC_HOST.has(sld) && !PLATFORM_RE.test(sld)) add(sld);
    }
  }
  return Array.from(t);
}

function reqIds_(s) {
  const out = new Set();
  (s.match(/\bR-?\d{4,}\b/gi) || []).forEach(x => out.add(x.toUpperCase().replace('-', '')));
  (s.match(/\b\d{5,}\b/g) || []).forEach(x => out.add(x));
  return Array.from(out);
}

// Role-title words from the Comments cell AND the posting URL (most career sites put the title in the URL).
function roleWords_(g, url, company) {
  let s = String(g).replace(/^(REJECTED[^|]*\|\s*)+/i, '');
  for (let i = 0; i < 2; i++) s = s.replace(/^(REJECTED|SUBMITTED|APPLIED)[^.|]*[.|]\s*/i, '');
  s = s.split(/\s\(|\s-\s|\s—\s|\|/)[0];
  const out = new Set(norm_(s).split(' ').filter(w => keepWord_(w) && !ROLE_NOISE.has(w)));
  const m = String(url || '').match(/^https?:\/\/[^\/]+([^?#]*)/i);
  if (m) {
    let path = m[1];
    try { path = decodeURIComponent(path); } catch (e) {}
    const co = norm_(company || '').split(' ').filter(w => w.length >= 4);
    path.toLowerCase().split(/[^a-z0-9]+/).forEach(w => {
      if (!keepWord_(w) || ROLE_NOISE.has(w) || URL_NOISE.has(w)) return;
      if (co.some(c => w.indexOf(c) >= 0)) return; // "marvellcareers", "pacificlifecareers"
      out.add(w);
    });
  }
  return Array.from(out);
}

// ---------------------------------------------------------------- Gmail (advanced service, read-only)

function listMessages_(q) {
  const ids = [];
  let token;
  do {
    const r = Gmail.Users.Messages.list('me', { q: q, maxResults: 100, pageToken: token });
    (r.messages || []).forEach(m => ids.push(m.id));
    token = r.nextPageToken;
  } while (token && ids.length < CFG.MAX_MESSAGES);
  return ids;
}

function readMessage_(id) {
  let msg;
  try { msg = Gmail.Users.Messages.get('me', id, { format: 'full' }); } catch (e) { return null; }
  const h = {};
  ((msg.payload && msg.payload.headers) || []).forEach(x => { h[x.name.toLowerCase()] = x.value; });
  return {
    id: id,
    from: h['from'] || '',
    subject: h['subject'] || '',
    date: Utilities.formatDate(new Date(Number(msg.internalDate)), CFG.TZ, 'M/d/yyyy'),
    body: bodyText_(msg.payload).slice(0, 8000),
  };
}

function bodyText_(part) {
  let plain = '';
  let html = '';
  const walk = p => {
    if (!p) return;
    if (p.body && p.body.data) {
      const s = decode_(p.body.data);
      if (p.mimeType === 'text/plain') plain += s + '\n';
      else if (p.mimeType === 'text/html') html += s + '\n';
    }
    (p.parts || []).forEach(walk);
  };
  walk(part);
  if (plain.trim()) return plain;
  return html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, ' ');
}

function decode_(data) {
  // The advanced service may hand back either a byte array or a web-safe base64 string.
  if (Array.isArray(data)) return Utilities.newBlob(data).getDataAsString('UTF-8');
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(String(data))).getDataAsString('UTF-8');
}

// ---------------------------------------------------------------- log + bookkeeping

function logSheet_(ss) {
  let s = ss.getSheetByName(CFG.LOG_TAB);
  if (!s) {
    s = ss.insertSheet(CFG.LOG_TAB);
    s.getRange(1, 1, 1, LOG_HEADER.length).setValues([LOG_HEADER]).setFontWeight('bold');
    s.setFrozenRows(1);
  }
  return s;
}

function handledIds_(log) {
  const last = log.getLastRow();
  if (last < 2) return new Set();
  return new Set(log.getRange(2, 1, last - 1, LOG_HEADER.length).getValues()
    .filter(r => r[8] && !/^(DRY RUN|WRITE FAILED)/.test(String(r[1])))
    .map(r => String(r[8])));
}

function loadSkipped_() {
  const raw = PropertiesService.getScriptProperties().getProperty(CFG.SKIP_KEY);
  return new Set(raw ? JSON.parse(raw) : []);
}

function saveSkipped_(set, add) {
  const arr = Array.from(set).concat(add).slice(-CFG.SKIP_CAP);
  PropertiesService.getScriptProperties().setProperty(CFG.SKIP_KEY, JSON.stringify(arr));
}

function norm_(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9&\-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normUrl_(u) {
  return String(u || '').trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, '')
    .replace(/[?#].*$/, '').replace(/\/+$/, '');
}

function now_() { return Utilities.formatDate(new Date(), CFG.TZ, 'M/d/yyyy HH:mm'); }
