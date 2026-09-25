/** Imported first by helpers.ts so test settings are in place before config is read. */
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/turnbyturn_test';
process.env.OTP_DEV_FIXED_CODE = '123456';
process.env.OTP_RESEND_COOLDOWN_SECONDS = '0';
process.env.SQUADCO_MOCK = 'true';
process.env.SQUADCO_SECRET_KEY = '';
