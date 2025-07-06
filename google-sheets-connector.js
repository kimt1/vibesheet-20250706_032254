const { google } = require('googleapis');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');

class GoogleSheetsConnector extends EventEmitter {
    constructor() {
        super();
        this.sheets = null;
        this.auth = null;
        this.pollIntervals = {};
    }

    async initGoogleAuth(config) {
        if (config.type === 'service_account') {
            const jwt = new google.auth.JWT(
                config.client_email,
                null,
                config.private_key.replace(/\\n/g, '\n'),
                [
                    'https://www.googleapis.com/auth/spreadsheets',
                    'https://www.googleapis.com/auth/drive'
                ]
            );
            await jwt.authorize();
            this.auth = jwt;
            this.sheets = google.sheets({ version: 'v4', auth: jwt });
        } else if (config.installed || config.web) {
            const credentials = config.installed || config.web;
            const oAuth2Client = new google.auth.OAuth2(
                credentials.client_id,
                credentials.client_secret,
                credentials.redirect_uris[0]
            );
            if (config.token) {
                oAuth2Client.setCredentials(config.token);
            } else {
                throw new Error('OAuth token needed for user account.');
            }
            this.auth = oAuth2Client;
            this.sheets = google.sheets({ version: 'v4', auth: oAuth2Client });
        } else {
            throw new Error('Invalid Google API credentials.');
        }
    }

    async fetchSpreadsheetData(sheetId, range) {
        this.#ensureInitialized();
        const res = await this.sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range,
        });
        return res.data.values || [];
    }

    async saveMappingToSheet(sheetId, mappingData) {
        this.#ensureInitialized();
        let values = mappingData;
        if (!Array.isArray(mappingData[0])) {
            values = [mappingData];
        }
        try {
            await this.sheets.spreadsheets.values.append({
                spreadsheetId: sheetId,
                range: 'A1',
                valueInputOption: 'RAW',
                insertDataOption: 'INSERT_ROWS',
                resource: { values },
            });
        } catch (err) {
            // Surface to caller
            throw err;
        }
    }

    listenForSheetUpdates(sheetId, callback, range = 'A1:Z1000', intervalMs = 5000) {
        this.#ensureInitialized();
        const normRange = (range || '').trim().toUpperCase();
        const intervalKey = `${sheetId}_${normRange}`;
        if (this.pollIntervals[intervalKey]) return; // Already listening

        let lastData = null;

        const poll = async () => {
            try {
                const data = await this.fetchSpreadsheetData(sheetId, range);
                const serialized = JSON.stringify(data);
                if (lastData !== null && lastData !== serialized) {
                    callback(data);
                }
                lastData = serialized;
            } catch (err) {
                this.emit('error', err);
            }
        };

        poll();
        this.pollIntervals[intervalKey] = setInterval(poll, intervalMs);
    }

    stopListeningForSheetUpdates(sheetId, range = 'A1:Z1000') {
        const normRange = (range || '').trim().toUpperCase();
        const intervalKey = `${sheetId}_${normRange}`;
        if (this.pollIntervals[intervalKey]) {
            clearInterval(this.pollIntervals[intervalKey]);
            delete this.pollIntervals[intervalKey];
        }
    }

    async importBatchProfiles(sheetId, range) {
        const rows = await this.fetchSpreadsheetData(sheetId, range);
        if (!rows || rows.length === 0) return [];
        const headers = rows[0];
        return rows.slice(1).map(row => {
            const obj = {};
            headers.forEach((h, i) => { obj[h] = row[i] || ''; });
            return obj;
        });
    }

    #ensureInitialized() {
        if (!this.sheets) throw new Error('Google Sheets not initialized. Call initGoogleAuth first.');
    }
}

module.exports = new GoogleSheetsConnector();