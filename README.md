# Job App Email Reject to GSheet

A Google Apps Script that automatically tracks job application rejections by reading your Gmail and updating a Google Sheet. It runs in the background on Google's servers.

## Features
- **Hourly Sweeps:** Searches your Gmail for the last 2 hours to find new rejection emails.
- **Smart Matching:** Matches the rejection email to the correct company and role in your Tracking sheet using company names, career site URLs, and requisition numbers.
- **Duplicate Prevention:** Safely ignores duplicate rejection emails and correctly prepends rejection notes to your existing comments.
- **Logging:** Maintains a clean "Rejection Log" tab (newest first) to track all automated updates and surface ambiguous/unmatched emails for manual review.

## Setup Instructions

1. **Prepare your Google Sheet:**
   - Download the `Sample_Jobs_Sheet.xlsx` file from this repository and upload it to Google Drive to convert it into a Google Sheet. It already contains the `Tracking` and `Rejection Log` tabs formatted correctly!
   - Alternatively, create your own sheet with a `Tracking` tab (ensure Column B is `Posting URL`, Column F is `Status`, Column G is `Comments`, and Column J is `Company`).

2. **Add the Script:**
   - Open your Google Sheet and go to **Extensions > Apps Script**.
   - Create a file named `RejectionSweep.gs` and paste the contents of `RejectionSweep.js` into it.
   - Click the gear icon (**Project Settings**) and check "Show appsscript.json manifest file in editor".
   - Replace the default `appsscript.json` with the contents of the `appsscript.json` provided in this repo.

3. **Install and Run:**
   - In the Apps Script Editor, select `installTriggers` from the top toolbar dropdown and click **Run**.
   - Review and accept the Google permissions prompt. (Since the script reads your Gmail and updates your Sheet, it requires these scopes).
   - Once installed, the script will automatically run in the background every hour!

## Safe Mode (Preview)
If you want to test the script without actually modifying your Tracking sheet, select `backfillPreview` from the dropdown and click **Run**. This will scan the last 30 days of emails and log what it *would* have updated into the Rejection Log tab marked as "DRY RUN".
