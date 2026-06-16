/*global CV,countlyVue,countlySodaRetentionRevenue*/
(function() {
    var featureName = "soda_retention_revenue";

    var SodaRetentionRevenueView = countlyVue.views.create({
        template: CV.T('/soda-retention-revenue/templates/soda-retention-revenue.html'),
        mixins: [countlyVue.mixins.commonFormatters],
        computed: {
            filters: {
                get: function() {
                    return this.$store.state.countlySodaRetentionRevenue.filters;
                },
                set: function(value) {
                    this.$store.dispatch('countlySodaRetentionRevenue/setFilters', value);
                    this.$store.dispatch('countlySodaRetentionRevenue/fetchAll', true);
                }
            },
            retentionRows: function() {
                return this.$store.state.countlySodaRetentionRevenue.retention.rows || [];
            },
            payerRetentionRows: function() {
                return this.$store.state.countlySodaRetentionRevenue.payerRetention.rows || [];
            },
            repeatPayRetentionRows: function() {
                return this.$store.state.countlySodaRetentionRevenue.repeatPayRetention.rows || [];
            },
            revenueRows: function() {
                return this.$store.state.countlySodaRetentionRevenue.revenue.rows || [];
            },
            revenueSummary: function() {
                return this.$store.state.countlySodaRetentionRevenue.revenue.summary || {};
            },
            bootstrapResult: function() {
                return this.$store.state.countlySodaRetentionRevenue.bootstrapResult;
            },
            hasRows: function() {
                return this.retentionRows.length || this.payerRetentionRows.length || this.repeatPayRetentionRows.length || this.revenueRows.length;
            },
            revenueChartOptions: function() {
                return {
                    xAxis: {
                        data: this.revenueRows.map(function(row) {
                            return row.key || '-';
                        })
                    },
                    yAxis: [{}, {}],
                    series: [{
                        name: 'Revenue',
                        type: 'bar',
                        data: this.revenueRows.map(function(row) {
                            return row.revenue || 0;
                        })
                    }, {
                        name: 'Payers',
                        type: 'line',
                        yAxisIndex: 1,
                        data: this.revenueRows.map(function(row) {
                            return row.pay_users || 0;
                        })
                    }]
                };
            },
            retentionChartOptions: function() {
                return this.makeRetentionChartOptions(this.retentionRows, 'Player Retention');
            },
            payerRetentionChartOptions: function() {
                return this.makeRetentionChartOptions(this.payerRetentionRows, 'Payer Active Retention');
            },
            repeatPayRetentionChartOptions: function() {
                return this.makeRetentionChartOptions(this.repeatPayRetentionRows, 'Repeat Pay Retention');
            },
            isLoading: function() {
                return this.$store.getters['countlySodaRetentionRevenue/isLoading'];
            }
        },
        methods: {
            refresh: function() {
                this.$store.dispatch('countlySodaRetentionRevenue/fetchAll', false);
            },
            bootstrap: function() {
                this.$store.dispatch('countlySodaRetentionRevenue/bootstrap');
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
            this.$store.dispatch('countlySodaRetentionRevenue/fetchAll', true);
        }
    });

    countlyVue.container.registerTab("/analytics/loyalty", {
        priority: 4,
        name: "soda-retention-revenue",
        permission: featureName,
        pluginName: "soda-retention-revenue",
        title: CV.i18n('soda-retention-revenue.title'),
        route: "#/analytics/loyalty/soda-retention-revenue",
        dataTestId: "soda-retention-revenue",
        component: SodaRetentionRevenueView,
        vuex: [{
            clyModel: countlySodaRetentionRevenue
        }]
    });
})();
