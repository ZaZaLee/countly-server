/*global app, countlyVue, CV, countlyCommon, countlyGlobal, CountlyHelpers, $ */
(function() {
    var DrillView = countlyVue.views.create({
        template: CV.T('/custom-drill/templates/drill.html'),
        data: function() {
            var routeArgs = this.$route && this.$route.params || {};
            var end = new Date();
            var start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
            var range = resolvePeriod(routeArgs.period, start, end);
            return {
                eventName: routeArgs.event || '',
                from: toLocalDateTime(range.from),
                to: toLocalDateTime(range.to),
                userId: '',
                deviceId: '',
                segmentKey: '',
                segmentValue: '',
                rows: [],
                cursor: null,
                hasMore: false,
                busy: false,
                error: ''
            };
        },
        methods: {
            search: function(append) {
                if (!this.eventName || !this.from || !this.to) {
                    this.error = 'Select an event and time range.';
                    return;
                }
                if (!append) {
                    this.rows = [];
                    this.cursor = null;
                }
                this.busy = true;
                this.error = '';
                var self = this;
                var query = {
                    app_id: countlyCommon.ACTIVE_APP_ID,
                    event: this.eventName,
                    from: new Date(this.from).getTime(),
                    to: new Date(this.to).getTime(),
                    page_size: 100
                };
                query.filters = JSON.stringify(this.getFilters());
                if (append && this.cursor) {
                    query.cursor = this.cursor;
                }
                $.ajax({
                    url: countlyCommon.API_URL + '/o/custom-drill/query',
                    data: query,
                    dataType: 'json'
                }).done(function(response) {
                    self.rows = self.rows.concat(response.documents || []);
                    self.cursor = response.next_cursor;
                    self.hasMore = Boolean(response.has_more);
                }).fail(function(xhr) {
                    self.error = xhr.responseJSON && xhr.responseJSON.result ? xhr.responseJSON.result : 'Unable to query raw events.';
                }).always(function() {
                    self.busy = false;
                });
            },
            exportCsv: function() {
                var query = $.param({
                    app_id: countlyCommon.ACTIVE_APP_ID,
                    auth_token: countlyGlobal.auth_token,
                    event: this.eventName,
                    from: new Date(this.from).getTime(),
                    to: new Date(this.to).getTime(),
                    filters: JSON.stringify(this.getFilters())
                });
                window.open(countlyCommon.API_URL + '/o/custom-drill/export?' + query, '_blank');
            },
            getFilters: function() {
                var filters = [];
                if (this.userId) {
                    filters.push({field: 'uid', operator: 'eq', value: this.userId});
                }
                if (this.deviceId) {
                    filters.push({field: 'did', operator: 'eq', value: this.deviceId});
                }
                if (this.segmentKey) {
                    filters.push({field: 'sg.' + this.segmentKey, operator: 'eq', value: this.segmentValue});
                }
                return filters;
            },
            formatTime: function(timestamp) {
                return new Date(timestamp).toLocaleString();
            },
            formatSegmentation: function(value) {
                return JSON.stringify(value || {});
            }
        }
    });

    var drillView = new countlyVue.views.BackboneWrapper({
        component: DrillView,
        templates: ['/custom-drill/templates/drill.html']
    });
    drillView.featureName = 'custom_drill';

    app.route('/custom-drill', 'custom-drill', function() {
        drillView.params = {};
        this.renderWhenReady(drillView);
    });
    app.route('/custom-drill/*args', 'custom-drill-event', function(args) {
        var routeArgs = args && CountlyHelpers.isJSON(args) ? JSON.parse(args) : {};
        drillView.params = routeArgs;
        this.renderWhenReady(drillView);
    });

    function toLocalDateTime(date) {
        if (!(date instanceof Date)) {
            date = new Date(Number(date) || date);
        }
        var local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
        return local.toISOString().slice(0, 16);
    }

    function resolvePeriod(period, fallbackStart, fallbackEnd) {
        if (Array.isArray(period) && period.length === 2) {
            return {from: period[0], to: period[1]};
        }
        var end = new Date(fallbackEnd);
        var start = new Date(fallbackStart);
        var duration = {
            hour: 60 * 60 * 1000,
            yesterday: 24 * 60 * 60 * 1000,
            '7days': 7 * 24 * 60 * 60 * 1000,
            '30days': 30 * 24 * 60 * 60 * 1000,
            '60days': 60 * 24 * 60 * 60 * 1000
        }[period];
        if (duration) {
            start = new Date(end.getTime() - duration);
        }
        else if (period === 'month') {
            start = new Date(end.getFullYear(), end.getMonth(), 1);
        }
        return {from: start, to: end};
    }
}());
