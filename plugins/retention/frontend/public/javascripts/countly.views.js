/*global CV,countlyVue,countlyRetention*/
(function() {
    var featureName = "retention";
    var currentScript = document.currentScript;
    var templateVersion = currentScript && currentScript.src && currentScript.src.indexOf("?") !== -1
        ? currentScript.src.split("?").slice(1).join("?")
        : ((window.countlyGlobal && (window.countlyGlobal.assetVersion || window.countlyGlobal.countlyVersion)) || "1");

    var RetentionView = countlyVue.views.create({
        template: CV.T('/retention/templates/retention.html?v=' + encodeURIComponent(templateVersion)),
        mixins: [countlyVue.mixins.commonFormatters],
        computed: {
            filters: {
                get: function() {
                    return this.$store.state.countlyRetention.filters;
                },
                set: function(value) {
                    this.$store.dispatch('countlyRetention/setFilters', value);
                    this.$store.dispatch('countlyRetention/fetchAll', true);
                }
            },
            retentionRows: function() {
                return this.$store.state.countlyRetention.retention.rows || [];
            },
            payerRetentionRows: function() {
                return this.$store.state.countlyRetention.payerRetention.rows || [];
            },
            repeatPayRetentionRows: function() {
                return this.$store.state.countlyRetention.repeatPayRetention.rows || [];
            },
            activityBucketRows: function() {
                return this.$store.state.countlyRetention.activityBuckets.rows || [];
            },
            hasRows: function() {
                return this.activityBucketRows.length || this.retentionRows.length || this.payerRetentionRows.length || this.repeatPayRetentionRows.length;
            },
            activityBucketChartOptions: function() {
                return {
                    xAxis: {
                        data: this.activityBucketRows.map(function(row) {
                            return this.formatBucket(row.bucket_start);
                        }, this)
                    },
                    yAxis: {},
                    series: [{
                        name: CV.i18n('retention.table.active-users'),
                        type: 'line',
                        data: this.activityBucketRows.map(function(row) {
                            return row.active_users || 0;
                        })
                    }],
                    title: {
                        text: CV.i18n('retention.chart.activity-trend'),
                        left: 'center',
                        textStyle: {
                            fontSize: 14,
                            fontWeight: 'normal'
                        }
                    }
                };
            },
            retentionChartOptions: function() {
                return this.makeRetentionChartOptions(this.retentionRows, CV.i18n('retention.chart.player-retention'));
            },
            payerRetentionChartOptions: function() {
                return this.makeRetentionChartOptions(this.payerRetentionRows, CV.i18n('retention.chart.payer-active-retention'));
            },
            repeatPayRetentionChartOptions: function() {
                return this.makeRetentionChartOptions(this.repeatPayRetentionRows, CV.i18n('retention.chart.repeat-pay-retention'));
            },
            isLoading: function() {
                return this.$store.getters['countlyRetention/isLoading'];
            }
        },
        methods: {
            refresh: function() {
                this.$store.dispatch('countlyRetention/fetchAll', false);
            },
            formatBucket: function(bucketStart) {
                return moment.unix(bucketStart).format('MM-DD HH:mm');
            },
            makeRetentionChartOptions: function(rows, title) {
                return {
                    legend: {
                        data: ['D1', 'D7', 'D30']
                    },
                    xAxis: {
                        data: rows.map(function(row) {
                            return row.date;
                        })
                    },
                    yAxis: {
                        axisLabel: {
                            formatter: '{value}%'
                        }
                    },
                    series: [{
                        name: 'D1',
                        type: 'line',
                        data: rows.map(function(row) {
                            return parseFloat(row.d1_rate) || 0;
                        })
                    }, {
                        name: 'D7',
                        type: 'line',
                        data: rows.map(function(row) {
                            return parseFloat(row.d7_rate) || 0;
                        })
                    }, {
                        name: 'D30',
                        type: 'line',
                        data: rows.map(function(row) {
                            return parseFloat(row.d30_rate) || 0;
                        })
                    }],
                    title: {
                        text: title,
                        left: 'center',
                        textStyle: {
                            fontSize: 14,
                            fontWeight: 'normal'
                        }
                    }
                };
            }
        },
        mounted: function() {
            this.$store.dispatch('countlyRetention/fetchAll', true);
        }
    });

    countlyVue.container.registerTab("/analytics/loyalty", {
        priority: 4,
        name: "retention",
        permission: featureName,
        pluginName: "retention",
        title: CV.i18n('retention.title'),
        route: "#/analytics/loyalty/retention",
        dataTestId: "retention",
        component: RetentionView,
        vuex: [{
            clyModel: countlyRetention
        }]
    });
})();
