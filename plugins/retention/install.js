var async = require('async'),
    pluginManager = require('../pluginManager.js');

console.log('Installing retention plugin');
pluginManager.dbConnection().then(function(countlyDb) {
    var indexes = [
        ['soda_user_activity_daily', {app_id: 1, date: 1, active_by_any_event: 1}, {background: true}],
        ['soda_user_activity_daily', {app_id: 1, uid: 1, date: 1}, {unique: true, background: true}],
        ['soda_user_activity_daily', {app_id: 1, channel: 1, date: 1}, {background: true}],
        ['soda_user_activity_bucket', {app_id: 1, uid: 1, bucket_type: 1, bucket_start: 1}, {unique: true, background: true}],
        ['soda_user_activity_bucket', {app_id: 1, bucket_type: 1, bucket_start: 1}, {background: true}],
        ['soda_user_activity_bucket', {app_id: 1, channel: 1, bucket_type: 1, bucket_start: 1}, {background: true}],
        ['soda_user_firsts', {app_id: 1, uid: 1}, {unique: true, background: true}],
        ['soda_user_firsts', {app_id: 1, first_active_date: 1}, {background: true}],
        ['soda_user_firsts', {app_id: 1, first_pay_date: 1}, {background: true}]
    ];

    async.forEach(indexes, function(item, done) {
        countlyDb.collection(item[0]).ensureIndex(item[1], item[2], done);
    }, function() {
        console.log('Retention plugin installation finished');
        countlyDb.close();
    });
});
