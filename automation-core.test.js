const { isSensitiveField, redactFieldValue } = require('./automation-core.js');

describe('isSensitiveField', () => {
    // Test cases for sensitive field names
    test('should identify "password" as sensitive', () => {
        expect(isSensitiveField('password')).toBe(true);
    });
    test('should identify "user_password" as sensitive', () => {
        expect(isSensitiveField('user_password')).toBe(true);
    });
    test('should identify "secret" as sensitive', () => {
        expect(isSensitiveField('secret')).toBe(true);
    });
    test('should identify "email" as sensitive', () => {
        expect(isSensitiveField('email')).toBe(true);
    });
    test('should identify "ssn" as sensitive', () => {
        expect(isSensitiveField('ssn')).toBe(true);
    });
    test('should identify "credit_card_number" as sensitive', () => {
        expect(isSensitiveField('credit_card_number')).toBe(true);
    });

    // Test cases for non-sensitive field names
    test('should not identify "username" as non-sensitive (based on regex)', () => {
        // The regex `user(name)?/i` makes this sensitive, so this test should reflect that.
        // Let's test a truly non-sensitive field instead.
        expect(isSensitiveField('description')).toBe(false);
    });
    test('should identify "username" as sensitive', () => {
        expect(isSensitiveField('username')).toBe(true);
    });
    test('should identify "user" as sensitive', () => {
        expect(isSensitiveField('user')).toBe(true);
    });
    test('should not identify "comment" as sensitive', () => {
        expect(isSensitiveField('comment')).toBe(false);
    });
});

describe('redactFieldValue', () => {
    test('should return "[REDACTED]" for any non-empty string', () => {
        expect(redactFieldValue('some-secret-value')).toBe('[REDACTED]');
    });
    test('should return "[REDACTED]" for a short string', () => {
        expect(redactFieldValue('123')).toBe('[REDACTED]');
    });
    test('should return an empty string for an empty input', () => {
        expect(redactFieldValue('')).toBe('');
    });
    test('should return an empty string for null or undefined input', () => {
        expect(redactFieldValue(null)).toBe('');
        expect(redactFieldValue(undefined)).toBe('');
    });
});
