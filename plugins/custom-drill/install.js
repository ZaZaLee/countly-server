'use strict';

const plugins = require('../pluginManager.js');

plugins.dbConnection('countly_drill').then(async function(db) {
    await Promise.all([
        db.collection('raw_events').createIndex({a: 1, e: 1, ts: -1, _id: -1}),
        db.collection('raw_events').createIndex({a: 1, uid: 1, ts: -1, _id: -1}),
        db.collection('raw_events').createIndex({a: 1, did: 1, ts: -1, _id: -1}),
        db.collection('raw_events').createIndex({expires_at: 1}, {expireAfterSeconds: 0}),
        db.collection('drill_meta').createIndex({a: 1, e: 1}, {unique: true})
    ]);
    console.log('Custom Drill indexes installed');
    await db.close();
}).catch(function(err) {
    console.error('Failed to install Custom Drill indexes', err);
    process.exitCode = 1;
});
