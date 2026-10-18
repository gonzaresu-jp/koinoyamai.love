'use strict';

const { initUserTables } = require('../../routes/user-helpers');
const userAuth = require('../../routes/user-auth');
const userProfile = require('../../routes/user-profile');
const userSchedules = require('../../routes/user-schedules');
const userInternal = require('../../routes/user-internal');

function register(app, db, authLimiter) {
  userAuth.register(app, db, authLimiter);
  userProfile.register(app, db);
  userSchedules.register(app, db);
  userInternal.register(app, db);
  console.log('[user-routes] all routes registered');
}

module.exports = { register, initUserTables };
