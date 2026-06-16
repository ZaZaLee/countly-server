/*global CV,countlyVue,countlyRevenue*/
(function() {
    var featureName = "revenue";
    var currentScript = document.currentScript;
    var templateVersion = currentScript && currentScript.src && currentScript.src.indexOf("?") !== -1
        ? currentScript.src.split("?").slice(1).join("?")
        : ((window.countlyGlobal && (window.countlyGlobal.assetVersion || window.countlyGlobal.countlyVersion)) || "1");

    var RevenueView = countlyVue.views.create({
        template: CV.T('/revenue/templates/revenue.html?v=' + encodeURIComponent(templateVersion)),
        mixins: [countlyVue.mixins.commonFormatters],
        computed: {
            filters: {
                get: function() {
                    return this.$store.state.countlyRevenue.filters;
                },
                set: function(value) {
                    this.$store.dispatch('countlyRevenue/setFilters', value);
                    this.$store.dispatch('countlyRevenue/fetchAll', true);
                }
            },
            revenueRows: function() {
                return this.$store.state.countlyRevenue.revenue.rows || [];
            },
            revenueSummary: function() {
                return this.$store.state.countlyRevenue.revenue.summary || {};
            },
            hasRows: function() {
                return this.revenueRows.length;
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
                        name: CV.i18n('revenue.chart.revenue'),
                        type: 'bar',
                        data: this.revenueRows.map(function(row) {
                            return row.revenue || 0;
                        })
                    }, {
                        name: CV.i18n('revenue.chart.payers'),
                        type: 'line',
                        yAxisIndex: 1,
                        data: this.revenueRows.map(function(row) {
                            return row.pay_users || 0;
                        })
                    }]
                };
            },
            isLoading: function() {
                return this.$store.getters['countlyRevenue/isLoading'];
            }
        },
        methods: {
            refresh: function() {
                this.$store.dispatch('countlyRevenue/fetchAll', false);
            }
        },
        mounted: function() {
            this.$store.dispatch('countlyRevenue/fetchAll', true);
        }
    });

    countlyVue.container.registerTab("/analytics/loyalty", {
        priority: 5,
        name: "revenue",
        permission: featureName,
        pluginName: "revenue",
        title: CV.i18n('revenue.title'),
        route: "#/analytics/loyalty/revenue",
        dataTestId: "revenue",
        component: RevenueView,
        vuex: [{
            clyModel: countlyRevenue
        }]
    });
})();
