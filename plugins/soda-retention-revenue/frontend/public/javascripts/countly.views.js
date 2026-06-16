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
            isLoading: function() {
                return this.$store.getters['countlySodaRetentionRevenue/isLoading'];
            }
        },
        methods: {
            refresh: function() {
                this.$store.dispatch('countlySodaRetentionRevenue/fetchAll', false);
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
