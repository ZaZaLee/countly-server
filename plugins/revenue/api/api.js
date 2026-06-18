'use strict';

const common = require('../../../api/utils/common.js'),
    plugins = require('../../pluginManager.js'),
    moment = require('moment-timezone'),
    crypto = require('crypto'),
    { validateRead } = require('../../../api/utils/rights.js');

const FEATURE_NAME = 'revenue';
const PLUGIN_NAME = 'revenue';
const COLLECTION_ACTIVITY = 'soda_user_activity_daily';
const COLLECTION_FIRSTS = 'soda_user_firsts';
const COLLECTION_PAYMENTS = 'soda_pay_order_fact';
const COLLECTION_AD_PAYMENTS = 'soda_ad_order_fact';

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
        ad_payment_success_event: 'v2_e_server_ad_pay_success',
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
            common.log('revenue').e('Failed to process event', err);
        }
        return true;
    });

    plugins.register('/o/revenue/revenue', function(ob) {
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
    const isPaymentSuccess = eventKey === config.payment_success_event;
    const isAdPaymentSuccess = eventKey === config.ad_payment_success_event;

    if (isPaymentSuccess) {
        writePayment(params.app_id, uid, date, eventTs, currEvent, segmentation, channel, config);
    }
    if (isAdPaymentSuccess) {
        writeAdPayment(params.app_id, uid, date, eventTs, currEvent, segmentation, channel, config);
    }
}

function writePayment(appId, uid, date, ts, currEvent, segmentation, channel, config) {
    const orderId = getFirstValue(segmentation, config.order_segments);
    const amountFen = toNumber(segmentation[config.amount_fen_segment]);
    const amountYuan = toNumber(currEvent.sum) || (amountFen ? amountFen / 100 : 0);
    if (amountFen <= 0 && amountYuan <= 0) {
        return;
    }
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
                common.log('revenue').e('Failed to write payment fact', err);
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

function writeAdPayment(appId, uid, date, ts, currEvent, segmentation, channel, config) {
    const orderId = getFirstValue(segmentation, config.order_segments);
    const iapId = getFirstValue(segmentation, config.iap_segments) || '';
    const dedupMode = orderId ? 'order_id' : 'event_fingerprint';
    const id = orderId ?
        [appId, orderId].join(':') :
        [appId, uid, date, ts, fingerprint(segmentation)].join(':');

    const doc = {
        _id: id,
        app_id: appId + '',
        uid: uid + '',
        order_id: orderId || '',
        date: date,
        ts: ts,
        iap_id: iapId + '',
        channel: channel ? channel + '' : '',
        dedup_mode: dedupMode,
        created_at: Date.now()
    };

    common.db.collection(COLLECTION_AD_PAYMENTS).updateOne(
        {_id: id},
        {$setOnInsert: doc},
        {upsert: true},
        function(err) {
            if (err && err.code !== 11000) {
                common.log('revenue').e('Failed to write ad payment fact', err);
            }
        }
    );
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
        const factRows = await common.db.collection(COLLECTION_PAYMENTS).aggregate([
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

        const historicalAggregate = groupBy === 'date' && !channel ? await getHistoricalRevenueAggregate(params, appId, range) : {rows: []};
        const aggregateRowsRaw = historicalAggregate.rows.map((row) => ({
            key: row.date,
            revenue: row.revenue,
            amount_fen: Math.round(row.revenue * 100),
            pay_orders: row.pay_orders,
            pay_users: 0,
            fallback_orders: row.pay_orders,
            aggregate_only: true
        }));
        const factKeys = {};
        factRows.forEach((row) => {
            factKeys[row.key || ''] = true;
        });
        const aggregateRows = aggregateRowsRaw.filter((row) => !factKeys[row.key || '']);

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
        aggregateRows.forEach((row) => {
            totalRevenue += toNumber(row.revenue);
            totalOrders += toNumber(row.pay_orders);
            totalFallbackOrders += toNumber(row.pay_orders);
        });

        const adStats = await getAdPaymentStats(appId, range, channel, groupBy);
        const adRowsByKey = {};
        adStats.rows.forEach((row) => {
            adRowsByKey[row.key || ''] = row;
        });

        const rows = mergeRevenueRows(factRows, aggregateRows).map((row) => {
            const adRow = adRowsByKey[row.key || ''] || {};
            row.revenue = round(row.revenue || 0, 2);
            row.arppu = row.pay_users ? round(row.revenue / row.pay_users, 2) : 0;
            row.ad_orders = adRow.ad_orders || 0;
            row.ad_users = adRow.ad_users || 0;
            return row;
        });
        adStats.rows.forEach((adRow) => {
            const exists = rows.some((row) => (row.key || '') === (adRow.key || ''));
            if (!exists) {
                rows.push({
                    key: adRow.key,
                    revenue: 0,
                    amount_fen: 0,
                    pay_orders: 0,
                    pay_users: 0,
                    arppu: 0,
                    ad_orders: adRow.ad_orders || 0,
                    ad_users: adRow.ad_users || 0,
                    fallback_orders: 0
                });
            }
        });
        rows.sort((a, b) => (a.key || '').localeCompare(b.key || ''));

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
                ad_orders: adStats.ad_orders,
                ad_users: adStats.ad_users,
                fallback_orders: totalFallbackOrders,
                aggregate_only_orders: aggregateRows.reduce((sum, row) => sum + toNumber(row.pay_orders), 0)
            }
        });
    }
    catch (err) {
        common.log('revenue').e('Revenue query failed', err);
        common.returnMessage(params, 500, 'Revenue query failed');
    }
}

async function getAdPaymentStats(appId, range, channel, groupBy) {
    const match = {
        app_id: appId,
        date: {$gte: range.from, $lte: range.to}
    };
    if (channel) {
        match.channel = channel + '';
    }

    const idExpr = groupBy === 'iap_id' ? '$iap_id' : (groupBy === 'channel' ? '$channel' : '$date');
    const rows = await common.db.collection(COLLECTION_AD_PAYMENTS).aggregate([
        {$match: match},
        {$group: {
            _id: idExpr,
            ad_orders: {$sum: 1},
            ad_users_set: {$addToSet: '$uid'}
        }},
        {$project: {
            _id: 0,
            key: '$_id',
            ad_orders: 1,
            ad_users: {$size: '$ad_users_set'}
        }},
        {$sort: {key: 1}}
    ], {allowDiskUse: true}).toArray();

    const userSet = {};
    let adOrders = 0;
    const docs = await common.db.collection(COLLECTION_AD_PAYMENTS).find(match, {uid: 1}).toArray();
    docs.forEach((doc) => {
        userSet[doc.uid] = true;
        adOrders++;
    });

    return {
        rows: rows,
        ad_orders: adOrders,
        ad_users: Object.keys(userSet).length
    };
}

async function getHistoricalRevenueAggregate(params, appId, range) {
    const config = getConfig(params);
    const collectionName = crypto.createHash('sha1').update(config.payment_success_event + appId).digest('hex');
    const docs = await common.db.collection('events_data').find({
        _id: {$regex: '^' + escapeRegExp(appId + '_' + collectionName + '_no-segment_')},
        a: appId + '',
        e: config.payment_success_event,
        s: 'no-segment'
    }, {d: 1}).toArray();

    const byDate = {};
    docs.forEach((doc) => {
        Object.keys(doc.d || {}).forEach((dayKey) => {
            if (!/^\d{4}\.\d{1,2}\.\d{1,2}$/.test(dayKey)) {
                return;
            }
            const date = moment.utc(dayKey, 'YYYY.M.D').format('YYYY-MM-DD');
            if (date < range.from || date > range.to) {
                return;
            }
            const dayData = doc.d[dayKey] || {};
            const revenue = toNumber(dayData[common.dbMap.sum]);
            const payOrders = toNumber(dayData[common.dbMap.count]);
            if (!revenue && !payOrders) {
                return;
            }
            if (!byDate[date]) {
                byDate[date] = {date: date, revenue: 0, pay_orders: 0};
            }
            byDate[date].revenue += revenue;
            byDate[date].pay_orders += payOrders;
        });
    });

    const rows = Object.keys(byDate).sort().map((date) => byDate[date]);
    let totalRevenue = 0;
    let totalOrders = 0;

    rows.forEach((row) => {
        totalRevenue += row.revenue;
        totalOrders += row.pay_orders;
    });

    return {
        rows: rows,
        row_count: rows.length,
        revenue: round(totalRevenue, 2),
        pay_orders: totalOrders
    };
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

function mergeRevenueRows(factRows, aggregateRows) {
    const byKey = {};
    (factRows || []).forEach((row) => {
        byKey[row.key || ''] = Object.assign({}, row);
    });
    (aggregateRows || []).forEach((row) => {
        const key = row.key || '';
        if (!byKey[key]) {
            byKey[key] = Object.assign({}, row);
            return;
        }
        byKey[key].revenue = toNumber(byKey[key].revenue) + toNumber(row.revenue);
        byKey[key].amount_fen = toNumber(byKey[key].amount_fen) + toNumber(row.amount_fen);
        byKey[key].pay_orders = toNumber(byKey[key].pay_orders) + toNumber(row.pay_orders);
        byKey[key].fallback_orders = toNumber(byKey[key].fallback_orders) + toNumber(row.fallback_orders);
        byKey[key].aggregate_only = byKey[key].aggregate_only || row.aggregate_only;
    });
    return Object.keys(byKey).sort().map((key) => byKey[key]);
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

function isDate(value) {
    return moment.utc(value, 'YYYY-MM-DD', true).isValid();
}

function getConfig(params) {
    return plugins.getConfig(PLUGIN_NAME, params && params.app && params.app.plugins, true);
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

function escapeRegExp(value) {
    return (value + '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
