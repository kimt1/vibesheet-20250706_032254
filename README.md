```markdown
# vibesheet-20250706_032254

[Project Design Doc](https://docs.google.com/document/d/1TyjLcGfwdmYnCNHkB9Hfb5wskEfjcd3ihukz20Tklpg/)

---

## Overview

**vibesheet-20250706_032254** (Form Master by J47) is a **modular, privacy-focused web automation platform** designed for **automatic detection, filling, and submission of web forms**?even on private/protected sites. The solution combines a cross-browser extension, scalable Node.js backend, and a rich React dashboard UI with deep Google Sheets integration. It is ideal for publishers, marketers, and sellers who require reliable batch automation, advanced error handling, analytics, and robust fallback strategies.

**Core capabilities:**  
- Detects and interacts with complex web forms (including Shadow DOM and CAPTCHA challenges)
- Simulates human-like interactions for undetectable automation
- Connects and synchronizes with Google Sheets for bulk operations
- Real-time feedback, error logs, and analytics via browser extension and dashboard

---

## Features

- **Multi-strategy Form Detection:** (DOM, Shadow DOM, selectors, OCR/visual fallback)
- **Human Simulation:** Mouse, keyboard, scroll, and timing randomization for realistic automation
- **Google Sheets Integration:** Secure data mapping and batch form filling from spreadsheets
- **Batch Automation:** Advanced scheduling, error handling, retry, and fallback mechanisms
- **Real-time Monitoring:** Logs, notifications, and analytics streamed instantly to dashboard
- **Cross-browser Extension:** Support for Chrome, Firefox, and Safari
- **Dynamic Content Handling:** CAPTCHAs and authenticated/sessioned sites
- **Modular/Extensible:** Pluggable detection and simulation modules
- **User Profile Management:** Access control, multiple automation profiles per user
- **i18n/Theming:** Localization and customizable look-and-feel
- **Privacy-centric:** Secure storage, authentication, and data syncing

---

## Architecture

1. **Browser Extension (WebExtensions API):**
   - Handles in-browser form detection, user mappings, and real-time feedback.
   - Communicates with backend for cloud sync, session management, and analytics.
   - Runs client-side simulation and fallback logic via modular libraries.

2. **Secure Node.js Backend:**
   - Manages authentication (OAuth), Google Sheets API, session persistence, analytics, and cloud storage (Firebase/S3/Firestore).
   - Provides API endpoints, WebSocket for real-time communication, and handles fallback logic when needed.

3. **React/TypeScript Dashboard UI:**
   - Provides configuration, scheduling, profile management, monitoring, and analytics.
   - Integrates authentication, data mapping, batch automation, log/error review, analytics visualization, and export tools.

---

## Installation

### 1. Clone the Repository

```sh
git clone https://github.com/yourusername/vibesheet-20250706_032254.git
cd vibesheet-20250706_032254
```

### 2. Install Backend & Dashboard Dependencies

```sh
npm install
```

### 3. Configure Environment

- Edit `config.ini` with your API keys, Google OAuth credentials, cloud storage info, and extension settings.
- If needed, adjust `package.json` scripts and extension build configs.

### 4. Build & Launch

- **Backend:**  
  Start the server (edit `server.js` as needed for custom settings).
  ```sh
  npm run server
  ```

- **Dashboard:**  
  (If set up as a standalone React app, build and serve as required.)
  ```sh
  npm run dashboard
  ```

- **Browser Extension:**  
  - Build/pack extension for your browser:
    ```sh
    npm run build:extension
    ```
  - Load the extension to your browser via extension management page using the generated `manifest.json`.

---

## Usage

### Typical Workflow

1. **Log In**
   - Access the dashboard and authenticate via OAuth.

2. **Connect Data Source**
   - Link your Google Sheets account and select/setup target spreadsheet(s).

3. **Define Automation Profile**
   - Create/set automation rules, map spreadsheet columns to form fields, adjust detection/simulation preferences.

4. **Launch Extension**
   - Open the targeted web page; the extension scans and highlights detectable forms.
   - Confirm or edit form mappings as suggested by the automation engine.

5. **Configure Human Simulation & Batch Settings**
   - Enable human-like input simulation, set up error handling, and batch parameters (e.g., number of rows per run, retry policies).

6. **Run Automation**
   - Launch batch run or schedule for later.
   - Receive live logs, status, and analytic feedback in dashboard and as browser notifications.

7. **Review & Export Analytics**
   - Analyze submission success/failure, error logs, and export reports from the dashboard.

---

## Example: Running a Batch Submission

1. In the dashboard, **connect** to your Google Sheet with row data prepared for form filling.
2. Create a **profile**, mapping each column to fields detected on your target website form.
3. Adjust batch settings (e.g., "submit 50 entries with 5s randomized delay").
4. Start the run. Monitor progress, interactive logs, and handle any CAPTCHAs or errors as they occur.  
5. Download/export analytics and logs as CSV/JSON for review.

---

## Components

| Component                | File                  | Purpose / Notes                                                  |
|--------------------------|-----------------------|------------------------------------------------------------------|
| **manifest**             | `manifest.json`       | Extension metadata/permissions for Chrome/Firefox/Safari         |
| **background**           | `background.js`       | Extension event logic, WebSockets, message routing               |
| **content-script**       | `content-script.js`   | Injected into sites for form detection/simulation                |
| **dashboard UI**         | `dashboard.jsx/.css`  | React-based dashboard, styling                                   |
| **server**               | `server.js`           | Node.js backend: OAuth, storage, APIs, analytics, WebSockets     |
| **form detection engine**| `form-detection-engine.js`<br>`formdetectionengine.js` | Detects/forms fields by DOM, selectors, visual fallback  |
| **human simulation**     | `human-simulation.js`<br>`humansimulation.js` | Simulates typing, mouse, scroll, random timing           |
| **Google Sheets connector**| `google-sheets-connector.js`<br>`googlesheetsconnector.js` | Spreadsheets API connection, data ingestion           |
| **session manager**      | `session-manager.js`<br>`sessionmanager.js` | Manages authentication, cookies, session persistence   |
| **batch processor**      | `batch-processor.js`<br>`batchprocessor.js` | Orchestrates batch form submissions & retries         |
| **fallback strategies**  | `fallback-strategies.js`<br>`fallbackstrategies.js` | Fallback logic for detection, CAPTCHA, error recovery |
| **config**               | `config.ini`          | Global settings, API keys, user preferences                      |
| **user profiles**        | `user-profiles.xml`<br>`userprofiles.xml` | Stores user/accounts configuration                      |
| **activity log**         | `activity.log`        | Persistent log of automation activities, issues                  |
| **i18n template**        | `i18n.pot`            | UI localization template                                         |
| **sidebar**              | `sidebar.jsx/.css`    | Dashboard sidebar navigation, quick status/errors                |
| **api layer**            | `api.js`              | Authenticated API calls between dashboard/backend                |
| **auth handler**         | `auth.js`             | OAuth, token refresh, auth state broadcasting                    |
| **notifications**        | `notifications.js`    | UI and browser notifications, alerts                             |
| **analytics**            | `analytics.js`        | Event collection, stats, reporting                               |
| **node hybrid**          | `node.js`             | Node backend, extra reconciliation logic                         |
| **contentscript**        | `contentscript.js`    | (Duplicate module; see `content-script.js`)                      |

> For in-depth pseudocode and research notes, see the "project plan" section or inline file comments.

---

## Dependencies

- **Node.js** (backend):  
  - express, dotenv, socket.io, firebase-admin (or AWS SDK for S3/Firestore)
  - googleapis (Google Sheets API)
- **React+TypeScript** (dashboard):  
  - react, react-dom, react-router, styled-components (or similar)
- **WebExtensions API**:  
  - Extension API compatible with Chrome, Firefox, and Safari
- **Localization**:  
  - gettext, i18next, or similar for i18n
- **Testing/Dev**:  
  - jest, eslint, prettier, webpack or equivalent
- **Other**:  
  - See `package.json` for a full dependency list

---

## Additional Notes

- All user configurations, mappings, and batch profiles are securely stored (XML/INI for structure, encrypted at rest in cloud).
- Privacy and session security are prioritized?automation runs in isolated contexts with careful cookie/session handling.
- Pluggable detection and simulation modules allow for fast adaptation to new form types or anti-bot mitigations.
- Supports multi-user environments with customizable access controls.
- The platform is extensible?future modules may support non-Google spreadsheets, API integrations, or machine learning-based detection.

---

## Support & Contributing

- For issues, bug reports, and feature requests:  
  Please use the GitHub [Issues](https://github.com/yourusername/vibesheet-20250706_032254/issues) tracker.
- To contribute or suggest enhancements, submit a pull request with clear description and usage/test notes.
- Documentation for advanced features and module customization can be found in the [Project Design Doc](https://docs.google.com/document/d/1TyjLcGfwdmYnCNHkB9Hfb5wskEfjcd3ihukz20Tklpg/).

---

_Copyright ? 2024_
```
