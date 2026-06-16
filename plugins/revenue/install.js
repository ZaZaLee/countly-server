var async = require('async'),
    pluginManager = require('../pluginManager.js');

console.log('Installing revenue plugin');
pluginManager.dbConnection().then(function(countlyDb) {
    var indexes = [
        ['soda_user_firsts', {app_id: 1, first_pay_date: 1}, {background: true}],
        ['soda_pay_order_fact', {app_id: 1, date: 1}, {background: true}],
        ['soda_pay_order_fact', {app_id: 1, uid: 1, date: 1}, {background: true}],
        ['soda_pay_order_fact', {app_id: 1, channel: 1, date: 1}, {background: true}],
        ['soda_pay_order_fact', {app_id: 1, order_id: 1}, {background: true}]
    ];

    async.forEach(indexes, function(item, done) {
        countlyDb.collection(item[0]).ensureIndex(item[1], item[2], done);
    }, function() {
        console.log('Revenue plugin installation finished');
        countlyDb.close();
    });
});
