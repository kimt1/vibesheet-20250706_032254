const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const csv = require('csv-parser');
const ini = require('ini');
const xml2js = require('xml2js');
const { format } = require('util');
const gettextParser = require('gettext-parser'); // Ensure dependency

class Logger {
    constructor(logFile) {
        this.logFile = logFile;
    }

    log(message) {
        const timestamp = new Date().toISOString();
        const entry = `[${timestamp}] ${message}\n`;
        fs.appendFileSync(this.logFile, entry, 'utf8');
    }
}

class ConfigLoader {
    constructor() {
        this.config = {};
    }

    loadINI(filePath) {
        const data = fs.readFileSync(filePath, 'utf-8');
        this.config = ini.parse(data);
        return this.config;
    }

    async loadXML(filePath) {
        const data = fs.readFileSync(filePath, 'utf-8');
        return new Promise((resolve, reject) => {
            xml2js.parseString(data, (err, result) => {
                if (err) return reject(err);
                this.config = { ...this.config, ...result };
                resolve(this.config);
            });
        });
    }
}

class Translator {
    constructor(potFile) {
        this.potFile = potFile;
        this.translations = this.loadPotProper(potFile);
    }

    loadPotProper(filePath) {
        if (!fs.existsSync(filePath)) return {};
        const raw = fs.readFileSync(filePath);
        let catalog;
        try {
            catalog = gettextParser.po.parse(raw);
        } catch (e) {
            return {};
        }
        const result = {};
        if (catalog.translations) {
            for (const ctx in catalog.translations) {
                for (const key in catalog.translations[ctx]) {
                    const trans = catalog.translations[ctx][key];
                    if (trans.msgid && trans.msgstr && trans.msgstr.length && trans.msgstr[0]) {
                        result[trans.msgid] = trans.msgstr[0];
                    }
                }
            }
        }
        return result;
    }

    t(key) {
        return this.translations[key] || key;
    }
}

function isSensitiveField(fieldName) {
    const sensitivePatterns = [
        /password/i,
        /passcode/i,
        /secret/i,
        /token/i,
        /auth/i,
        /ssn/i,
        /social/i,
        /credit/i,
        /card/i,
        /cvv/i,
        /cvc/i,
        /pin\b/i,
        /email/i,
        /phone/i,
        /\bmobile\b/i,
        /\bun\/,username/i,
        /user(name)?/i,
    ];
    return sensitivePatterns.some((pat) => pat.test(fieldName));
}

function redactFieldValue(fieldValue) {
    if (!fieldValue) return '';
    // Simple mask, depending on length/type, could be more advanced
    return '[REDACTED]';
}

class FormAutomator {
    constructor(options) {
        this.logger = new Logger(options.logFile || 'formmaster.log');
        this.configLoader = new ConfigLoader();
        this.translator = new Translator(options.potFile || 'messages.pot');
        this.browser = null;
    }

    async launchBrowser() {
        try {
            this.browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
            this.logger.log(this.translator.t('Browser launched'));
        } catch (e) {
            this.logger.log(this.translator.t('Browser launch failed') + ': ' + e.message);
            throw e;
        }
    }

    async closeBrowser() {
        if (this.browser) {
            await this.browser.close();
            this.logger.log(this.translator.t('Browser closed'));
        }
    }

    async processCSVData(csvPath) {
        return new Promise((resolve, reject) => {
            const results = [];
            fs.createReadStream(csvPath)
                .pipe(csv())
                .on('data', (data) => results.push(data))
                .on('end', () => resolve(results))
                .on('error', (err) => reject(err));
        });
    }

    async detectAndFillForm(page, formData) {
        // Detect form
        const forms = await page.$$('form');
        if (!forms.length) {
            this.logger.log(this.translator.t('No form found'));
            return false;
        }
        for (let form of forms) {
            const inputs = await form.$$('[name]');
            let filled = false;
            for (let input of inputs) {
                const name = await input.evaluate(el => el.name);
                if (formData[name]) {
                    await input.focus();
                    await input.click({ clickCount: 3 });
                    await input.type(formData[name], { delay: 80 + Math.random() * 40 });
                    filled = true;
                    if (isSensitiveField(name)) {
                        this.logger.log(format(this.translator.t('Filled field: %s (redacted)'), name));
                    } else {
                        this.logger.log(format(this.translator.t('Filled field: %s'), name));
                    }
                }
            }
            if (filled) {
                // Try submission
                try {
                    await form.evaluate(f => f.submit());
                    this.logger.log(this.translator.t('Form submitted'));
                    return true;
                } catch (e) {
                    this.logger.log(this.translator.t('Form submission failed') + ': ' + e.message);
                    return false;
                }
            }
        }
        return false;
    }

    async automate(url, formData) {
        await this.launchBrowser();
        const page = await this.browser.newPage();
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            this.logger.log(format(this.translator.t('Navigated to: %s'), url));
            const result = await this.detectAndFillForm(page, formData);
            if (result) {
                this.logger.log(this.translator.t('Automation succeeded'));
            } else {
                this.logger.log(this.translator.t('Automation failed (no form filled or submitted)'));
            }
        } catch (e) {
            this.logger.log(this.translator.t('Automation error') + ': ' + e.message);
        } finally {
            await page.close();
            await this.closeBrowser();
        }
    }
}

module.exports = { FormAutomator, ConfigLoader, Logger, Translator };