'use strict';

const common = require('../../../api/utils/common.js');
const plugins = require('../../pluginManager.js');
const log = common.log('custom-drill');
const { validateRead } = require('../../../api/utils/rights.js');

const FEATURE_NAME = 'custom_drill';
const COLLECTION_EVENTS = 'raw_events';
const COLLECTION_META = 'drill_meta';
const DEFAULT_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 365;
const MAX_QUEUE_SIZE = 20000;
const MAX_BATCH_SIZE = 500;
const MAX_PAGE_SIZE = 100;
const MAX_EXPORT_SIZE = 10000;
const MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000;
const FIELD_NAME_PATTERN = /^[^.$\0]{1,128}$/;

let drillDb;
let queue = [];
let droppedCount = 0;
let flushInProgress = false;

plugins.register('/permissions/features', function(ob) {
    if (isEnabled()) {
        ob.features.push(FEATURE_NAME);
    }
});

plugins.register('/i/events', function(ob) {
    if (!isEnabled()) {
        return false;
    }
    try {
        enqueueEvent(ob);
    }
    catch (err) {
        log.e('Could not enqueue raw event', err);
    }
    return true;
});

plugins.register('/o/custom-drill/events', function(ob) {
    const params = ob.params;
    if (!isEnabled()) {
        return common.returnMessage(params, 404, 'Custom Drill is disabled');
    }
    validateRead(params, FEATURE_NAME, async function() {
        try {
            const appId = validateAppId(params.qstring.app_id);
            if (!appId) {
                return common.returnMessage(params, 400, 'Invalid app_id');
            }
            const events = await getDrillDb().collection(COLLECTION_META)
                .find({a: appId}, {projection: {e: 1, last_seen_at: 1, _id: 0}})
                .sort({e: 1})
                .limit(1000)
                .toArray();
            common.returnOutput(params, events);
        }
        catch (err) {
            log.e('Failed to list raw events', err);
            common.returnMessage(params, 500, 'Failed to list raw events');
        }
    });
    return true;
});

plugins.register('/o/custom-drill/query', function(ob) {
    const params = ob.params;
    if (!isEnabled()) {
        return common.returnMessage(params, 404, 'Custom Drill is disabled');
    }
    validateRead(params, FEATURE_NAME, async function() {
        try {
            const parsed = parseQuery(params.qstring);
            if (parsed.error) {
                return common.returnMessage(params, 400, parsed.error);
            }
            const db = getDrillDb();
            const collection = db.collection(COLLECTION_EVENTS);
            const filter = Object.assign({}, parsed.filter);
            if (parsed.cursor) {
                filter.$and = (filter.$and || []).concat([{
                    $or: [
                        {ts: {$lt: parsed.cursor.ts}},
                        {ts: parsed.cursor.ts, _id: {$lt: common.db.ObjectID(parsed.cursor.id)}}
                    ]
                }]);
            }
            const documents = await collection.find(filter, {
                projection: {
                    a: 1,
                    e: 1,
                    ts: 1,
                    uid: 1,
                    did: 1,
                    sg: 1,
                    count: 1,
                    sum: 1,
                    dur: 1,
                    received_at: 1,
                    event_time: 1,
                    request_id: 1,
                    app_version: 1,
                    platform: 1
                }
            })
                .sort({ts: -1, _id: -1})
                .limit(parsed.pageSize + 1)
                .toArray();
            const hasMore = documents.length > parsed.pageSize;
            if (hasMore) {
                documents.pop();
            }
            const lastDocument = documents[documents.length - 1];

            common.returnOutput(params, {
                page_size: parsed.pageSize,
                has_more: hasMore,
                next_cursor: hasMore && lastDocument ? encodeCursor(lastDocument) : null,
                documents: documents
            });
        }
        catch (err) {
            log.e('Failed to query raw events', err);
            common.returnMessage(params, 500, 'Failed to query raw events');
        }
    });
    return true;
});

plugins.register('/o/custom-drill/export', function(ob) {
    const params = ob.params;
    if (!isEnabled()) {
        return common.returnMessage(params, 404, 'Custom Drill is disabled');
    }
    validateRead(params, FEATURE_NAME, async function() {
        try {
            const parsed = parseQuery(params.qstring);
            if (parsed.error) {
                return common.returnMessage(params, 400, parsed.error);
            }
            const rows = await getDrillDb().collection(COLLECTION_EVENTS)
                .find(parsed.filter)
                .sort({ts: -1, _id: -1})
                .limit(MAX_EXPORT_SIZE)
                .toArray();
            const columns = ['ts', 'e', 'uid', 'did', 'count', 'sum', 'dur', 'app_version', 'platform', 'sg'];
            const csv = [columns.join(',')].concat(rows.map(function(row) {
                return columns.map(function(column) {
                    const value = column === 'sg' ? JSON.stringify(row.sg || {}) : row[column];
                    return csvCell(value);
                }).join(',');
            })).join('\r\n');
            params.res.status(200);
            params.res.set('Content-Type', 'text/csv; charset=utf-8');
            params.res.set('Content-Disposition', 'attachment; filename="custom-drill-events.csv"');
            params.res.send('\uFEFF' + csv);
        }
        catch (err) {
            log.e('Failed to export raw events', err);
            common.returnMessage(params, 500, 'Failed to export raw events');
        }
    });
    return true;
});

plugins.register('/o/custom-drill/health', function(ob) {
    const params = ob.params;
    if (!isEnabled()) {
        return common.returnMessage(params, 404, 'Custom Drill is disabled');
    }
    validateRead(params, FEATURE_NAME, function() {
        common.returnOutput(params, {
            database: 'countly_drill',
            queue_size: queue.length,
            dropped_total: droppedCount,
            ready: Boolean(drillDb)
        });
    });
    return true;
});

initialize();

function initialize() {
    if (!isEnabled()) {
        return;
    }
    drillDb = common.drillDb;
    if (!drillDb) {
        log.e('countly_drill connection is unavailable; raw event archiving is disabled');
        return;
    }

    Promise.all([
        drillDb.collection(COLLECTION_EVENTS).createIndex({a: 1, e: 1, ts: -1, _id: -1}),
        drillDb.collection(COLLECTION_EVENTS).createIndex({a: 1, uid: 1, ts: -1, _id: -1}),
        drillDb.collection(COLLECTION_EVENTS).createIndex({a: 1, did: 1, ts: -1, _id: -1}),
        drillDb.collection(COLLECTION_EVENTS).createIndex({expires_at: 1}, {expireAfterSeconds: 0}),
        drillDb.collection(COLLECTION_META).createIndex({a: 1, e: 1}, {unique: true})
    ]).catch(function(err) {
        log.e('Failed to initialize Custom Drill indexes', err);
    });

    setInterval(flushQueue, 1000).unref();
}

function enqueueEvent(ob) {
    if (!drillDb || !ob || !ob.params || !ob.currEvent || !ob.params.app_id) {
        return;
    }

    const params = ob.params;
    const event = ob.currEvent;
    if (typeof event.key !== 'string' || !event.key || event.key.length > 256) {
        return;
    }

    if (queue.length >= MAX_QUEUE_SIZE) {
        droppedCount++;
        if (droppedCount === 1 || droppedCount % 1000 === 0) {
            log.e('Raw event queue is full; dropped events total: %d', droppedCount);
        }
        return;
    }

    const receivedAt = new Date();
    const eventTimestamp = parseTimestamp(event.timestamp) || parseTimestamp(params.time && params.time.timestamp) || receivedAt.getTime();
    const retentionDays = getRetentionDays();
    const segmentation = event.segmentation && typeof event.segmentation === 'object' && !Array.isArray(event.segmentation) ?
        event.segmentation : {};
    const appUser = params.app_user || {};
    const metrics = params.qstring && params.qstring.metrics || {};
    const appVersion = metrics._app_version || metrics.app_version || appUser.av || '';
    const platform = metrics._device_type || metrics.device_type || appUser.dt || '';
    const doc = {
        a: String(params.app_id),
        e: event.key,
        ts: eventTimestamp,
        uid: appUser.uid ? String(appUser.uid) : '',
        did: params.qstring && params.qstring.device_id ? String(params.qstring.device_id) : '',
        sg: cloneSegmentation(segmentation),
        count: finiteNumber(event.count, 1),
        sum: finiteNumber(event.sum, 0),
        dur: finiteNumber(event.dur, 0),
        received_at: receivedAt,
        event_time: new Date(eventTimestamp),
        request_id: params.request_id || '',
        event_index: Number.isInteger(ob.eventIndex) ? ob.eventIndex : 0,
        app_version: String(appVersion || ''),
        platform: String(platform || ''),
        expires_at: new Date(receivedAt.getTime() + retentionDays * 24 * 60 * 60 * 1000),
        raw_version: 1
    };

    queue.push(doc);
    if (queue.length >= MAX_BATCH_SIZE) {
        setImmediate(flushQueue);
    }
}

async function flushQueue() {
    if (!drillDb || flushInProgress || queue.length === 0) {
        return;
    }
    flushInProgress = true;
    const batch = queue.splice(0, MAX_BATCH_SIZE);
    try {
        await drillDb.collection(COLLECTION_EVENTS).insertMany(batch, {ordered: false});
    }
    catch (err) {
        const failedWrites = err.writeErrors && err.writeErrors.length ? err.writeErrors.length : batch.length;
        droppedCount += failedWrites;
        log.e('Failed to write raw event batch; failed count %d, failed total %d', failedWrites, droppedCount, err);
    }
    try {
        await updateMetadata(batch);
    }
    catch (err) {
        log.e('Failed to update raw event metadata', err);
    }
    finally {
        flushInProgress = false;
        if (queue.length >= MAX_BATCH_SIZE) {
            setImmediate(flushQueue);
        }
    }
}

async function updateMetadata(batch) {
    const eventDocs = new Map();
    for (const doc of batch) {
        const key = doc.a + ':' + doc.e;
        let meta = eventDocs.get(key);
        if (!meta) {
            meta = {
                a: doc.a,
                e: doc.e,
                first_seen_at: doc.received_at,
                last_seen_at: doc.received_at,
                fields: new Set()
            };
            eventDocs.set(key, meta);
        }
        meta.last_seen_at = doc.received_at;
        for (const field of Object.keys(doc.sg)) {
            if (FIELD_NAME_PATTERN.test(field)) {
                meta.fields.add(field);
            }
        }
    }

    const operations = [];
    for (const meta of eventDocs.values()) {
        operations.push({
            updateOne: {
                filter: {a: meta.a, e: meta.e},
                update: {
                    $set: {last_seen_at: meta.last_seen_at},
                    $setOnInsert: {first_seen_at: meta.first_seen_at},
                    $addToSet: {fields: {$each: Array.from(meta.fields)}}
                },
                upsert: true
            }
        });
    }
    if (operations.length) {
        await drillDb.collection(COLLECTION_META).bulkWrite(operations, {ordered: false});
    }
}

function parseQuery(qstring) {
    const appId = validateAppId(qstring.app_id);
    const event = typeof qstring.event === 'string' ? qstring.event.trim() : '';
    const from = parseTimestamp(qstring.from);
    const to = parseTimestamp(qstring.to);
    const pageSize = Number(qstring.page_size || 50);
    if (!appId || !event || event.length > 256) {
        return {error: 'app_id and a valid event are required'};
    }
    if (!from || !to || to <= from || to - from > MAX_RANGE_MS) {
        return {error: 'A valid time range up to 31 days is required'};
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
        return {error: 'page_size must be between 1 and 100'};
    }

    let cursor = null;
    if (qstring.cursor) {
        cursor = decodeCursor(qstring.cursor);
        if (!cursor) {
            return {error: 'cursor is invalid'};
        }
    }

    const filter = {a: appId, e: event, ts: {$gte: from, $lt: to}};
    let rawFilters = qstring.filters || [];
    if (typeof rawFilters === 'string') {
        try {
            rawFilters = JSON.parse(rawFilters);
        }
        catch (_err) {
            return {error: 'filters must be a valid JSON array'};
        }
    }
    if (!Array.isArray(rawFilters) || rawFilters.length > 10) {
        return {error: 'filters must be an array with at most 10 items'};
    }

    for (const item of rawFilters) {
        const field = normalizeField(item && item.field);
        const operator = item && item.operator;
        if (!field || !['eq', 'ne', 'in', 'exists', 'gte', 'gt', 'lte', 'lt'].includes(operator)) {
            return {error: 'Invalid filter field or operator'};
        }
        const mongoOperator = {
            eq: '$eq',
            ne: '$ne',
            in: '$in',
            exists: '$exists',
            gte: '$gte',
            gt: '$gt',
            lte: '$lte',
            lt: '$lt'
        }[operator];
        let value = item.value;
        if (operator === 'in') {
            if (!Array.isArray(value) || value.length > 50 || value.some(isUnsafeFilterValue)) {
                return {error: 'in filter values must be an array with at most 50 items'};
            }
        }
        if (operator === 'exists' && typeof value !== 'boolean') {
            return {error: 'exists filter value must be boolean'};
        }
        if (operator !== 'in' && operator !== 'exists' && (value === undefined || value === null || isUnsafeFilterValue(value))) {
            return {error: 'Invalid filter value'};
        }
        if (!filter[field] || typeof filter[field] !== 'object' || Array.isArray(filter[field])) {
            filter[field] = {};
        }
        filter[field][mongoOperator] = value;
    }

    return {filter, pageSize, cursor};
}

function encodeCursor(document) {
    return Buffer.from(JSON.stringify({ts: document.ts, id: document._id.toString()})).toString('base64url');
}

function decodeCursor(value) {
    if (typeof value !== 'string' || value.length > 256) {
        return null;
    }
    try {
        const decoded = JSON.parse(Buffer.from(value, 'base64url').toString());
        if (!Number.isFinite(decoded.ts) || typeof decoded.id !== 'string' || !/^[a-f\d]{24}$/i.test(decoded.id)) {
            return null;
        }
        return {ts: decoded.ts, id: decoded.id};
    }
    catch (_err) {
        return null;
    }
}

function csvCell(value) {
    if (value === undefined || value === null) {
        return '""';
    }
    let text = String(value);
    if (/^[\s]*[=+\-@]/.test(text)) {
        text = "'" + text;
    }
    return '"' + text.replace(/"/g, '""') + '"';
}

function normalizeField(field) {
    if (field === 'uid' || field === 'did') {
        return field;
    }
    if (typeof field !== 'string' || !field.startsWith('sg.')) {
        return null;
    }
    const name = field.slice(3);
    if (!FIELD_NAME_PATTERN.test(name)) {
        return null;
    }
    return 'sg.' + name;
}

function isUnsafeFilterValue(value) {
    if (value === null || typeof value === 'object') {
        return true;
    }
    return typeof value === 'string' && value.length > 1024;
}

function validateAppId(appId) {
    if (typeof appId !== 'string' || !/^[a-f\d]{24}$/i.test(appId)) {
        return null;
    }
    return appId;
}

function parseTimestamp(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
        return Math.floor(numeric < 100000000000 ? numeric * 1000 : numeric);
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function finiteNumber(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

function cloneSegmentation(segmentation) {
    try {
        const serialized = JSON.stringify(segmentation);
        if (!serialized || serialized.length > 200000) {
            return {};
        }
        return sanitizeMongoValue(JSON.parse(serialized));
    }
    catch (_err) {
        return {};
    }
}

function sanitizeMongoValue(value) {
    if (Array.isArray(value)) {
        return value.map(sanitizeMongoValue);
    }
    if (value && typeof value === 'object') {
        const result = {};
        for (const key of Object.keys(value)) {
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
                continue;
            }
            const safeKey = key.replace(/\./g, '\uFF0E').replace(/^\$/, '\uFF04');
            result[safeKey] = sanitizeMongoValue(value[key]);
        }
        return result;
    }
    return value;
}

function isEnabled() {
    return plugins.isPluginEnabled('custom-drill');
}

function getRetentionDays() {
    const value = Number(process.env.COUNTLY_CUSTOM_DRILL_RETENTION_DAYS || DEFAULT_RETENTION_DAYS);
    if (!Number.isInteger(value) || value < 1 || value > MAX_RETENTION_DAYS) {
        return DEFAULT_RETENTION_DAYS;
    }
    return value;
}

function getDrillDb() {
    if (!drillDb) {
        throw new Error('countly_drill database is unavailable');
    }
    return drillDb;
}

process.on('beforeExit', function() {
    if (queue.length) {
        flushQueue();
    }
});
