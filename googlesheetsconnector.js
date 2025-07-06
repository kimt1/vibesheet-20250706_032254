const { google } = require('googleapis');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

function numberToColumnLetter(num) {
  // num: 1 => 'A', 26 => 'Z', 27 => 'AA', 52 => 'AZ', 53 => 'BA', etc.
  let letters = '';
  while (num > 0) {
    let remainder = (num - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    num = Math.floor((num - 1) / 26);
  }
  return letters;
}

class GoogleSheetsConnector extends EventEmitter {
  constructor() {
    super();
    this.auth = null;
    this.sheets = null;
    this.watchIntervalMs = 30000;
    this._watchers = {};
    this._lastDataCache = {};
  }

  async initGoogleAuth(config) {
    let credentials;
    if (config.credentialsJSON) {
      credentials = JSON.parse(config.credentialsJSON);
    } else if (config.credentialsPath) {
      credentials = JSON.parse(fs.readFileSync(config.credentialsPath, 'utf8'));
    } else {
      throw new Error('Google Auth config requires credentialsJSON or credentialsPath');
    }
    const scopes = [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.file'
    ];
    this.auth = new google.auth.GoogleAuth({
      credentials,
      scopes,
    });
    this.sheets = google.sheets({ version: 'v4', auth: await this.auth.getClient() });
  }

  async fetchSpreadsheetData(sheetId, range) {
    if (!this.sheets) throw new Error('GoogleSheetsConnector not initialized');
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range,
      valueRenderOption: 'UNFORMATTED_VALUE'
    });
    return res.data.values || [];
  }

  async saveMappingToSheet(sheetId, mappingData) {
    if (!this.sheets) throw new Error('GoogleSheetsConnector not initialized');
    if (!Array.isArray(mappingData) || !mappingData.length)
      throw new Error('mappingData must be a non-empty 2D array');
    // Compute range for arbitrary column length
    const numRows = mappingData.length;
    const numCols = mappingData[0].length;
    if (numCols < 1) throw new Error('mappingData row must have at least one column');
    const endCol = numberToColumnLetter(numCols);
    const range = `A1:${endCol}${numRows}`;
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      resource: { values: mappingData }
    });
    return true;
  }

  listenForSheetUpdates(sheetId, range, callback) {
    // Use a safe delimiter to prevent accidental key collisions
    const key = `${sheetId}||${range}`;
    if (this._watchers[key]) return;
    this._lastDataCache[key] = null;
    const poll = async () => {
      try {
        const data = await this.fetchSpreadsheetData(sheetId, range);
        const dataStr = JSON.stringify(data);
        if (this._lastDataCache[key] !== dataStr) {
          this._lastDataCache[key] = dataStr;
          callback(data);
          this.emit('sheetUpdate', { sheetId, range, data });
        }
      } catch (e) {
        this.emit('error', e);
      }
    };
    poll();
    this._watchers[key] = setInterval(poll, this.watchIntervalMs);
  }

  removeSheetListener(sheetId, range) {
    const key = `${sheetId}||${range}`;
    if (this._watchers[key]) {
      clearInterval(this._watchers[key]);
      delete this._watchers[key];
      delete this._lastDataCache[key];
    }
  }

  async importBatchProfiles(sheetId, range) {
    const data = await this.fetchSpreadsheetData(sheetId, range);
    if (!data || !data.length) return [];
    // Validate header row
    const headersRaw = data[0];
    const headers = [];
    const seenHeaders = new Set();
    for (let i = 0; i < headersRaw.length; ++i) {
      const h = headersRaw[i] && typeof headersRaw[i] === 'string' ? headersRaw[i].trim() : String(headersRaw[i] || '').trim();
      if (!h) throw new Error(`Header at column ${numberToColumnLetter(i + 1)} is empty`);
      if (seenHeaders.has(h)) throw new Error(`Duplicate header "${h}" found at column ${numberToColumnLetter(i + 1)}`);
      seenHeaders.add(h);
      headers.push(h);
    }
    const profiles = [];
    for (let i = 1; i < data.length; ++i) {
      const row = data[i];
      const profile = {};
      for (let j = 0; j < headers.length; ++j) {
        profile[headers[j]] = row[j];
      }
      profiles.push(profile);
    }
    return profiles;
  }
}

module.exports = new GoogleSheetsConnector();