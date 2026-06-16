'use strict';

const common = require('../../../api/utils/common.js'),
    plugins = require('../../pluginManager.js'),
    moment = require('moment-timezone'),
    crypto = require('crypto'),
    { validateRead } = require('../../../api/utils/rights.js');

const FEATURE_NAME = 'soda_retention_revenue';
const PLUGIN_NAME = 'soda-retention-revenue';
const COLLECTION_ACTIVITY = 'soda_user_activity_daily';
const COLLECTION_FIRSTS = 'soda_user_firsts';
const COLLECTION_PAYMENTS = 'soda_pay_order_fact';

const DEFAULT_DAYS = [1, 2, 3, 7, 14, 30];
const MAX_RANGE_DAYS = 120;

(function() {
    plugins.register('/permissions/features', function(ob) {
        ob.features.push(FEATURE_NAME);
    });

    plugins.setConfigs(PLUGIN_NAME, {
        activity_mode: 'any',
        login_events: [
            'v2_e_server_login',
            'v2_e_login',
            'v2_e_relogin',
            'v2_e_account_login',
            'v2_e_launch'
        ],
        payment_success_event: 'v2_e_server_pay_success',
        payment_attempt_event: 'v2_e_in_app_purchase',
        excluded_activity_events: [
            'v2_e_shutdown'
        ],
        channel_segments: [
            'v2_p_channel',
            'v2_game_channel',
            'channel',
            'sdk_channel',
            'platform'
        ],
        order_segments: [
            'order_id',
            'v2_p_order_id',
            'v2_p_iap_order_id'
        ],
        iap_segments: [
            'iap_id',
            'v2_p_iap_bundle_id',
            'product_id'
        ],
        amount_fen_segment: 'v2_p_amount_fen'
    });

    plugins.register('/i/events', function(ob) {
        try {
            processEvent(ob.params, ob.currEvent);
        }
        catch (err) {
            common.log('soda-retention-revenue').e('Failed to process event', err);
        }
        return true;
    });

    plugins.register('/o/soda-retention-revenue/retention', function(ob) {
        const params = ob.params;
        validateRead(params, FEATURE_NAME, function() {
            handleRetention(params, 'active');
        });
        return true;
    });

    plugins.register('/o/soda-retention-revenue/payer-retention', function(ob) {
        const params = ob.params;
        validateRead(params, FEATURE_NAME, function() {
            handleRetention(params, 'payer');
        });
        return true;
    });

    plugins.register('/o/soda-retention-revenue/repeat-pay-retention', function(ob) {
        const params = ob.params;
        validateRead(params, FEATURE_NAME, function() {
            handleRetention(params, 'payer-repeat-pay');
        });
        return true;
    });

    plugins.register('/o/soda-retention-revenue/revenue', function(ob) {
        const params = ob.params;
        validateRead(params, FEATURE_NAME, function() {
            handleRevenue(params);
        });
        return true;
    });
}());

function processEvent(params, currEvent) {
    if (!params || !currEvent || !currEvent.key || !params.app_id) {
        return;
    }

    const uid = getUid(params);
    if (!uid) {
        return;
    }

    const config = getConfig(params);
    const eventKey = currEvent.key + '';
    const eventTs = getEventTimestamp(params, currEvent);
    const date = formatDate(params.appTimezone, eventTs);
    const segmentation = currEvent.segmentation || {};
    const channel = getFirstValue(segmentation, config.channel_segments) || getUserChannel(params) || '';
    const isLogin = config.login_events.indexOf(eventKey) !== -1;
    const isPaymentSuccess = eventKey === config.payment_success_event;
    const isActivity = isTrackableActivity(eventKey, config);

    if (isActivity) {
        writeActivity(params.app_id, uid, date, eventTs, eventKey, isLogin, eventKey !== '[CLY]_session', channel);
    }

    if (isPaymentSuccess) {
        writePayment(params.app_id, uid, date, eventTs, currEvent, segmentation, channel, config);
    }
}

function writeActivity(appId, uid, date, ts, eventKey, isLogin, activeByAnyEvent, channel) {
    const id = [appId, uid, date].join(':');
    const set = {
        _id: id,
        app_id: appId + '',
        uid: uid + '',
        date: date,
        updated_at: Date.now()
    };

    if (channel) {
        set.channel = channel + '';
    }

    const update = {
        $set: set,
        $setOnInsert: {
            created_at: Date.now(),
            first_event: eventKey
        },
        $inc: {
            event_count: 1
        },
        $min: {
            first_ts: ts
        },
        $max: {
            last_ts: ts
        }
    };

    update.$max.active_by_any_event = activeByAnyEvent ? 1 : 0;
    update.$max.active_by_login = isLogin ? 1 : 0;

    common.writeBatcher.add(COLLECTION_ACTIVITY, id, update);

    const firstId = [appId, uid].join(':');
    const firstUpdate = {
        $set: {
            _id: firstId,
            app_id: appId + '',
            uid: uid + '',
            updated_at: Date.now()
        },
        $setOnInsert: {
            created_at: Date.now(),
            first_active_date: date
        },
        $min: {
            first_active_ts: ts
        }
    };

    if (isLogin) {
        firstUpdate.$setOnInsert.first_login_date = date;
        firstUpdate.$min.first_login_ts = ts;
        common.db.collection(COLLECTION_FIRSTS).updateOne(
            {_id: firstId, first_login_date: {$exists: false}},
            {$set: {first_login_date: date}},
            function() {}
        );
    }
    if (channel) {
        firstUpdate.$set.channel = channel + '';
    }

    common.writeBatcher.add(COLLECTION_FIRSTS, firstId, firstUpdate);
}

function writePayment(appId, uid, date, ts, currEvent, segmentation, channel, config) {
    const orderId = getFirstValue(segmentation, config.order_segments);
    const amountFen = toNumber(segmentation[config.amount_fen_segment]);
    const amountYuan = toNumber(currEvent.sum) || (amountFen ? amountFen / 100 : 0);
    const iapId = getFirstValue(segmentation, config.iap_segments) || '';
    const dedupMode = orderId ? 'order_id' : 'event_fingerprint';
    const id = orderId ?
        [appId, orderId].join(':') :
        [appId, uid, date, ts, amountFen || amountYuan, fingerprint(segmentation)].join(':');

    const doc = {
        _id: id,
        app_id: appId + '',
        uid: uid + '',
        order_id: orderId || '',
        date: date,
        ts: ts,
        amount_fen: amountFen || Math.round(amountYuan * 100),
        amount_yuan: amountYuan,
        iap_id: iapId + '',
        channel: channel ? channel + '' : '',
        dedup_mode: dedupMode,
        created_at: Date.now()
    };

    common.db.collection(COLLECTION_PAYMENTS).updateOne(
        {_id: id},
        {$setOnInsert: doc},
        {upsert: true},
        function(err) {
            if (err && err.code !== 11000) {
                common.log('soda-retention-revenue').e('Failed to write payment fact', err);
            }
        }
    );

    const firstId = [appId, uid].join(':');
    const firstUpdate = {
        $set: {
            _id: firstId,
            app_id: appId + '',
            uid: uid + '',
            updated_at: Date.now()
        },
        $setOnInsert: {
            created_at: Date.now(),
            first_pay_date: date
        },
        $min: {
            first_pay_ts: ts
        }
    };
    common.writeBatcher.add(COLLECTION_FIRSTS, firstId, firstUpdate);

    common.db.collection(COLLECTION_FIRSTS).updateOne(
        {_id: firstId, first_pay_date: {$exists: false}},
        {$set: {first_pay_date: date, first_pay_ts: ts}},
        function() {}
    );
}

async function handleRetention(params, type) {
    const appId = params.qstring.app_id + '';
    const range = parseRange(params);
    const days = parseDays(params.qstring.days);
    const mode = normalizeActivityMode(params.qstring.activity_mode || getConfig(params).activity_mode);
    const channel = params.qstring.channel;
    const cohortType = params.qstring.cohort_type || 'new_active';
    const activityField = mode === 'login' ? 'active_by_login' : 'active_by_any_event';

    if (!range.ok) {
        common.returnMessage(params, 400, range.error);
        return;
    }

    try {
        let cohorts;
        if (type === 'payer' || type === 'payer-repeat-pay') {
            cohorts = await getPayerCohorts(appId, range.from, range.to, channel);
        }
        else if (cohortType === 'active') {
            cohorts = await getActiveCohorts(appId, range.from, range.to, activityField, channel);
        }
        else {
            cohorts = await getNewActiveCohorts(appId, range.from, range.to, channel);
        }

        const cohortDates = cohorts.map((row) => row.date);
        const cohortUsers = {};
        cohorts.forEach((row) => {
            cohortUsers[row.date] = row.users || [];
        });

        const maxDay = Math.max.apply(null, days.concat([0]));
        const activityByDate = await getActivityUsersByDate(appId, range.from, addDays(range.to, maxDay), activityField, channel);
        const payByDate = type === 'payer-repeat-pay' ? await getPaymentUsersByDate(appId, range.from, addDays(range.to, maxDay), channel) : {};

        const rows = cohortDates.map((date) => {
            const users = cohortUsers[date] || [];
            const userSet = makeSet(users);
            const row = {
                date: date,
                cohort_users: users.length,
                retention: {}
            };

            days.forEach((day) => {
                const targetDate = addDays(date, day);
                const targetUsers = type === 'payer-repeat-pay' ? (payByDate[targetDate] || []) : (activityByDate[targetDate] || []);
                const retained = countIntersect(userSet, targetUsers);
                row.retention['d' + day] = {
                    users: retained,
                    rate: users.length ? round(retained * 100 / users.length, 2) : 0
                };
            });
            return row;
        });

        common.returnOutput(params, {
            type: type,
            activity_mode: mode,
            cohort_type: type === 'active' ? cohortType : type,
            days: days,
            from: range.from,
            to: range.to,
            rows: rows
        });
    }
    catch (err) {
        common.log('soda-retention-revenue').e('Retention query failed', err);
        common.returnMessage(params, 500, 'Retention query failed');
    }
}

async function handleRevenue(params) {
    const appId = params.qstring.app_id + '';
    const range = parseRange(params);
    const channel = params.qstring.channel;
    const groupBy = params.qstring.group_by || 'date';

    if (!range.ok) {
        common.returnMessage(params, 400, range.error);
        return;
    }

    try {
        const paymentMatch = {
            app_id: appId,
            date: {$gte: range.from, $lte: range.to}
        };
        if (channel) {
            paymentMatch.channel = channel + '';
        }

        const idExpr = groupBy === 'iap_id' ? '$iap_id' : (groupBy === 'channel' ? '$channel' : '$date');
        const revenueRows = await common.db.collection(COLLECTION_PAYMENTS).aggregate([
            {$match: paymentMatch},
            {$group: {
                _id: idExpr,
                revenue: {$sum: '$amount_yuan'},
                amount_fen: {$sum: '$amount_fen'},
                pay_orders: {$sum: 1},
                pay_users_set: {$addToSet: '$uid'},
                fallback_orders: {$sum: {$cond: [{$eq: ['$dedup_mode', 'event_fingerprint']}, 1, 0]}}
            }},
            {$project: {
                _id: 0,
                key: '$_id',
                revenue: 1,
                amount_fen: 1,
                pay_orders: 1,
                pay_users: {$size: '$pay_users_set'},
                fallback_orders: 1
            }},
            {$sort: {key: 1}}
        ], {allowDiskUse: true}).toArray();

        const activeUsersByDate = await getActivityUsersByDate(appId, range.from, range.to, 'active_by_any_event', channel);
        const activeUsers = countUnion(activeUsersByDate);
        let totalRevenue = 0;
        let totalOrders = 0;
        let totalFallbackOrders = 0;
        const payerSet = {};

        const payerDocs = await common.db.collection(COLLECTION_PAYMENTS).find(paymentMatch, {uid: 1, amount_yuan: 1, dedup_mode: 1}).toArray();
        payerDocs.forEach((doc) => {
            payerSet[doc.uid] = true;
            totalRevenue += toNumber(doc.amount_yuan);
            totalOrders++;
            if (doc.dedup_mode === 'event_fingerprint') {
                totalFallbackOrders++;
            }
        });

        const payUsers = Object.keys(payerSet).length;
        const rows = revenueRows.map((row) => {
            row.revenue = round(row.revenue || 0, 2);
            row.arppu = row.pay_users ? round(row.revenue / row.pay_users, 2) : 0;
            return row;
        });

        common.returnOutput(params, {
            from: range.from,
            to: range.to,
            group_by: groupBy,
            rows: rows,
            summary: {
                revenue: round(totalRevenue, 2),
                pay_orders: totalOrders,
                pay_users: payUsers,
                active_users: activeUsers,
                arpu: activeUsers ? round(totalRevenue / activeUsers, 2) : 0,
                arppu: payUsers ? round(totalRevenue / payUsers, 2) : 0,
                pay_rate: activeUsers ? round(payUsers * 100 / activeUsers, 2) : 0,
                fallback_orders: totalFallbackOrders
            }
        });
    }
    catch (err) {
        common.log('soda-retention-revenue').e('Revenue query failed', err);
        common.returnMessage(params, 500, 'Revenue query failed');
    }
}

async function getNewActiveCohorts(appId, from, to, channel) {
    const match = {
        app_id: appId,
        first_active_date: {$gte: from, $lte: to}
    };
    if (channel) {
        match.channel = channel + '';
    }
    return common.db.collection(COLLECTION_FIRSTS).aggregate([
        {$match: match},
        {$group: {_id: '$first_active_date', users: {$addToSet: '$uid'}}},
        {$project: {_id: 0, date: '$_id', users: 1}},
        {$sort: {date: 1}}
    ], {allowDiskUse: true}).toArray();
}

async function getActiveCohorts(appId, from, to, activityField, channel) {
    const match = {
        app_id: appId,
        date: {$gte: from, $lte: to}
    };
    match[activityField] = 1;
    if (channel) {
        match.channel = channel + '';
    }
    return common.db.collection(COLLECTION_ACTIVITY).aggregate([
        {$match: match},
        {$group: {_id: '$date', users: {$addToSet: '$uid'}}},
        {$project: {_id: 0, date: '$_id', users: 1}},
        {$sort: {date: 1}}
    ], {allowDiskUse: true}).toArray();
}

async function getPayerCohorts(appId, from, to, channel) {
    const match = {
        app_id: appId,
        first_pay_date: {$gte: from, $lte: to}
    };
    if (channel) {
        match.channel = channel + '';
    }
    return common.db.collection(COLLECTION_FIRSTS).aggregate([
        {$match: match},
        {$group: {_id: '$first_pay_date', users: {$addToSet: '$uid'}}},
        {$project: {_id: 0, date: '$_id', users: 1}},
        {$sort: {date: 1}}
    ], {allowDiskUse: true}).toArray();
}

async function getActivityUsersByDate(appId, from, to, activityField, channel) {
    const match = {
        app_id: appId,
        date: {$gte: from, $lte: to}
    };
    match[activityField] = 1;
    if (channel) {
        match.channel = channel + '';
    }
    const rows = await common.db.collection(COLLECTION_ACTIVITY).aggregate([
        {$match: match},
        {$group: {_id: '$date', users: {$addToSet: '$uid'}}},
        {$project: {_id: 0, date: '$_id', users: 1}}
    ], {allowDiskUse: true}).toArray();

    const ret = {};
    rows.forEach((row) => {
        ret[row.date] = row.users || [];
    });
    return ret;
}

async function getPaymentUsersByDate(appId, from, to, channel) {
    const match = {
        app_id: appId,
        date: {$gte: from, $lte: to}
    };
    if (channel) {
        match.channel = channel + '';
    }
    const rows = await common.db.collection(COLLECTION_PAYMENTS).aggregate([
        {$match: match},
        {$group: {_id: '$date', users: {$addToSet: '$uid'}}},
        {$project: {_id: 0, date: '$_id', users: 1}}
    ], {allowDiskUse: true}).toArray();

    const ret = {};
    rows.forEach((row) => {
        ret[row.date] = row.users || [];
    });
    return ret;
}

function getUid(params) {
    if (params.app_user && params.app_user.uid) {
        return params.app_user.uid + '';
    }
    if (params.qstring && params.qstring.device_id) {
        return params.qstring.device_id + '';
    }
    return '';
}

function getEventTimestamp(params, currEvent) {
    const ts = currEvent.timestamp || (params.qstring && params.qstring.timestamp) || (params.time && params.time.timestamp);
    const timeObj = common.initTimeObj(params.appTimezone, ts);
    return timeObj.timestamp;
}

function formatDate(timezone, timestamp) {
    return moment.unix(timestamp).tz(timezone || 'UTC').format('YYYY-MM-DD');
}

function addDays(date, days) {
    return moment.utc(date, 'YYYY-MM-DD').add(days, 'days').format('YYYY-MM-DD');
}

function parseRange(params) {
    const q = params.qstring || {};
    const timezone = params.appTimezone || 'UTC';
    let from = q.from;
    let to = q.to;

    if (!from || !to) {
        to = moment().tz(timezone).format('YYYY-MM-DD');
        from = moment().tz(timezone).subtract(30, 'days').format('YYYY-MM-DD');
    }

    if (!isDate(from) || !isDate(to)) {
        return {ok: false, error: 'Invalid date format, expected YYYY-MM-DD'};
    }

    const start = moment.utc(from, 'YYYY-MM-DD');
    const end = moment.utc(to, 'YYYY-MM-DD');
    if (end.isBefore(start)) {
        return {ok: false, error: 'Invalid date range'};
    }
    if (end.diff(start, 'days') > MAX_RANGE_DAYS) {
        return {ok: false, error: 'Date range is too large'};
    }
    return {ok: true, from: from, to: to};
}

function parseDays(raw) {
    if (!raw) {
        return DEFAULT_DAYS;
    }
    const days = (raw + '').split(',').map((item) => parseInt(item, 10)).filter((item) => !isNaN(item) && item >= 0 && item <= 90);
    return days.length ? days : DEFAULT_DAYS;
}

function isDate(value) {
    return moment.utc(value, 'YYYY-MM-DD', true).isValid();
}

function normalizeActivityMode(value) {
    return value === 'login' ? 'login' : 'any';
}

function getConfig(params) {
    return plugins.getConfig(PLUGIN_NAME, params && params.app && params.app.plugins, true);
}

function isTrackableActivity(eventKey, config) {
    if (eventKey.indexOf('[CLY]_') === 0) {
        return false;
    }
    if (config.excluded_activity_events.indexOf(eventKey) !== -1) {
        return false;
    }
    return true;
}

function getFirstValue(obj, keys) {
    for (let i = 0; i < keys.length; i++) {
        const value = obj[keys[i]];
        if (value !== undefined && value !== null && value !== '') {
            return value + '';
        }
    }
    return '';
}

function getUserChannel(params) {
    if (!params.app_user) {
        return '';
    }
    return params.app_user.c || params.app_user.channel || '';
}

function toNumber(value) {
    if (value === undefined || value === null || value === '') {
        return 0;
    }
    const parsed = parseFloat(value);
    return isNaN(parsed) ? 0 : parsed;
}

function fingerprint(value) {
    return crypto.createHash('sha1').update(JSON.stringify(value || {})).digest('hex').slice(0, 12);
}

function makeSet(values) {
    const ret = {};
    (values || []).forEach((value) => {
        ret[value] = true;
    });
    return ret;
}

function countIntersect(set, values) {
    let count = 0;
    (values || []).forEach((value) => {
        if (set[value]) {
            count++;
        }
    });
    return count;
}

function countUnion(byDate) {
    const ret = {};
    Object.keys(byDate || {}).forEach((date) => {
        (byDate[date] || []).forEach((uid) => {
            ret[uid] = true;
        });
    });
    return Object.keys(ret).length;
}

function round(value, precision) {
    const multi = Math.pow(10, precision || 2);
    return Math.round((value || 0) * multi) / multi;
}
