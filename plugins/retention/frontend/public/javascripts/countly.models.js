/*global countlyCommon,CV,countlyVue,moment*/
(function(countlyRetention) {

    var DEFAULT_DAYS = [1, 2, 3, 7, 14, 30];

    function defaultFilters() {
        return {
            from: moment().subtract(30, 'days').format('YYYY-MM-DD'),
            to: moment().format('YYYY-MM-DD'),
            days: DEFAULT_DAYS.slice(),
            activityMode: 'any',
            channel: ''
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

    function mapRetentionResponse(response) {
        var days = response.days || [];
        (response.rows || []).forEach(function(row) {
            days.forEach(function(day) {
                var item = row.retention && row.retention['d' + day] ? row.retention['d' + day] : {};
                row['d' + day + '_users'] = item.users || 0;
                row['d' + day + '_rate'] = (item.rate || 0) + '%';
            });
        });
        return response;
    }

    function normalizeFilters(filters) {
        var defaults = defaultFilters();
        filters = filters || {};
        Object.keys(filters).forEach(function(key) {
            if (filters[key] !== undefined && filters[key] !== null && filters[key] !== '') {
                defaults[key] = filters[key];
            }
        });
        if (!Array.isArray(defaults.days)) {
            defaults.days = DEFAULT_DAYS.slice();
        }
        return defaults;
    }

    countlyRetention.service = {
        defaultFilters: defaultFilters,
        fetchRetention: function(filters) {
            filters = normalizeFilters(filters);
            return fetchApi('/o/retention/retention', {
                app_id: countlyCommon.ACTIVE_APP_ID,
                from: filters.from,
                to: filters.to,
                days: filters.days.join(','),
                activity_mode: filters.activityMode,
                channel: filters.channel || ''
            }).then(mapRetentionResponse);
        },
        fetchPayerRetention: function(filters) {
            filters = normalizeFilters(filters);
            return fetchApi('/o/retention/payer-retention', {
                app_id: countlyCommon.ACTIVE_APP_ID,
                from: filters.from,
                to: filters.to,
                days: filters.days.join(','),
                channel: filters.channel || ''
            }).then(mapRetentionResponse);
        },
        fetchRepeatPayRetention: function(filters) {
            filters = normalizeFilters(filters);
            return fetchApi('/o/retention/repeat-pay-retention', {
                app_id: countlyCommon.ACTIVE_APP_ID,
                from: filters.from,
                to: filters.to,
                days: filters.days.join(','),
                channel: filters.channel || ''
            }).then(mapRetentionResponse);
        },
        bootstrap: function(filters) {
            filters = normalizeFilters(filters);
            return fetchApi('/o/retention/bootstrap', {
                app_id: countlyCommon.ACTIVE_APP_ID,
                from: filters.from,
                to: filters.to
            });
        }
    };

    countlyRetention.getVuexModule = function() {
        var getInitialState = function() {
            return {
                filters: defaultFilters(),
                retention: {rows: [], type: 'active'},
                payerRetention: {rows: [], type: 'payer'},
                repeatPayRetention: {rows: [], type: 'payer-repeat-pay'},
                bootstrapResult: null
            };
        };

        return countlyVue.vuex.Module("countlyRetention", {
            state: getInitialState,
            actions: {
                setFilters: function(context, filters) {
                    context.commit('setFilters', normalizeFilters(filters));
                },
                fetchAll: function(context, useLoader) {
                    context.dispatch('onFetchInit', {useLoader: useLoader});
                    var filters = normalizeFilters(context.state.filters);
                    context.commit('setFilters', filters);
                    return Promise.all([
                        countlyRetention.service.fetchRetention(filters),
                        countlyRetention.service.fetchPayerRetention(filters),
                        countlyRetention.service.fetchRepeatPayRetention(filters)
                    ]).then(function(response) {
                        context.commit('setRetention', response[0]);
                        context.commit('setPayerRetention', response[1]);
                        context.commit('setRepeatPayRetention', response[2]);
                        context.dispatch('onFetchSuccess', {useLoader: useLoader});
                    }).catch(function(error) {
                        context.dispatch('onFetchError', {error: error, useLoader: useLoader});
                    });
                },
                bootstrap: function(context) {
                    context.dispatch('onFetchInit', {useLoader: true});
                    return countlyRetention.service.bootstrap(context.state.filters)
                        .then(function(response) {
                            context.commit('setBootstrapResult', response);
                            return context.dispatch('fetchAll', true);
                        }).catch(function(error) {
                            context.dispatch('onFetchError', {error: error, useLoader: true});
                        });
                }
            },
            mutations: {
                setFilters: function(state, value) {
                    state.filters = value;
                },
                setRetention: function(state, value) {
                    state.retention = value;
                },
                setPayerRetention: function(state, value) {
                    state.payerRetention = value;
                },
                setRepeatPayRetention: function(state, value) {
                    state.repeatPayRetention = value;
                },
                setBootstrapResult: function(state, value) {
                    state.bootstrapResult = value;
                }
            },
            submodules: [countlyVue.vuex.FetchMixin()]
        });
    };
}(window.countlyRetention = window.countlyRetention || {}));
