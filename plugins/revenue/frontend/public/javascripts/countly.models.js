/*global countlyCommon,CV,countlyVue,moment*/
(function(countlyRevenue) {

    function defaultFilters() {
        return {
            from: moment().subtract(30, 'days').format('YYYY-MM-DD'),
            to: moment().format('YYYY-MM-DD'),
            channel: '',
            groupBy: 'date'
        };
    }

    function fetchApi(path, data) {
        return new Promise(function(resolve, reject) {
            CV.$.ajax({
                type: "GET",
                url: countlyCommon.API_URL + path,
                data: data
            }, {disableAutoCatch: true}).then(resolve).catch(reject);
        });
    }

    function normalizeFilters(filters) {
        var defaults = defaultFilters();
        filters = filters || {};
        Object.keys(filters).forEach(function(key) {
            if (filters[key] !== undefined && filters[key] !== null && filters[key] !== '') {
                defaults[key] = filters[key];
            }
        });
        return defaults;
    }

    countlyRevenue.service = {
        defaultFilters: defaultFilters,
        fetchRevenue: function(filters) {
            filters = normalizeFilters(filters);
            return fetchApi('/o/revenue/revenue', {
                app_id: countlyCommon.ACTIVE_APP_ID,
                from: filters.from,
                to: filters.to,
                group_by: filters.groupBy,
                channel: filters.channel || ''
            });
        }
    };

    countlyRevenue.getVuexModule = function() {
        var getInitialState = function() {
            return {
                filters: defaultFilters(),
                revenue: {rows: [], summary: {}}
            };
        };

        return countlyVue.vuex.Module("countlyRevenue", {
            state: getInitialState,
            actions: {
                setFilters: function(context, filters) {
                    context.commit('setFilters', normalizeFilters(filters));
                },
                fetchAll: function(context, useLoader) {
                    context.dispatch('onFetchInit', {useLoader: useLoader});
                    var filters = normalizeFilters(context.state.filters);
                    context.commit('setFilters', filters);
                    return countlyRevenue.service.fetchRevenue(filters).then(function(response) {
                        context.commit('setRevenue', response);
                        context.dispatch('onFetchSuccess', {useLoader: useLoader});
                    }).catch(function(error) {
                        context.dispatch('onFetchError', {error: error, useLoader: useLoader});
                    });
                }
            },
            mutations: {
                setFilters: function(state, value) {
                    state.filters = value;
                },
                setRevenue: function(state, value) {
                    state.revenue = value;
                }
            },
            submodules: [countlyVue.vuex.FetchMixin()]
        });
    };
}(window.countlyRevenue = window.countlyRevenue || {}));
