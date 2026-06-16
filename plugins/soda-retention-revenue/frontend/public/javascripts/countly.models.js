/*global countlyCommon,CV,countlyVue*/
(function(countlySodaRetentionRevenue) {

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

    countlySodaRetentionRevenue.service = {
        fetchRetention: function(filters) {
            return fetchApi('/o/soda-retention-revenue/retention', {
                app_id: countlyCommon.ACTIVE_APP_ID,
                from: filters.from,
                to: filters.to,
                days: filters.days.join(','),
                activity_mode: filters.activityMode,
                channel: filters.channel || ''
            }).then(mapRetentionResponse);
        },
        fetchPayerRetention: function(filters) {
            return fetchApi('/o/soda-retention-revenue/payer-retention', {
                app_id: countlyCommon.ACTIVE_APP_ID,
                from: filters.from,
                to: filters.to,
                days: filters.days.join(','),
                channel: filters.channel || ''
            }).then(mapRetentionResponse);
        },
        fetchRepeatPayRetention: function(filters) {
            return fetchApi('/o/soda-retention-revenue/repeat-pay-retention', {
                app_id: countlyCommon.ACTIVE_APP_ID,
                from: filters.from,
                to: filters.to,
                days: filters.days.join(','),
                channel: filters.channel || ''
            }).then(mapRetentionResponse);
        },
        fetchRevenue: function(filters) {
            return fetchApi('/o/soda-retention-revenue/revenue', {
                app_id: countlyCommon.ACTIVE_APP_ID,
                from: filters.from,
                to: filters.to,
                group_by: filters.groupBy,
                channel: filters.channel || ''
            });
        }
    };

    countlySodaRetentionRevenue.getVuexModule = function() {
        var getInitialState = function() {
            return {
                filters: {
                    from: '',
                    to: '',
                    days: [1, 2, 3, 7, 14, 30],
                    activityMode: 'any',
                    channel: '',
                    groupBy: 'date'
                },
                retention: {rows: [], type: 'active'},
                payerRetention: {rows: [], type: 'payer'},
                repeatPayRetention: {rows: [], type: 'payer-repeat-pay'},
                revenue: {rows: [], summary: {}}
            };
        };

        return countlyVue.vuex.Module("countlySodaRetentionRevenue", {
            state: getInitialState,
            actions: {
                setFilters: function(context, filters) {
                    context.commit('setFilters', filters);
                },
                fetchAll: function(context, useLoader) {
                    context.dispatch('onFetchInit', {useLoader: useLoader});
                    var filters = context.state.filters;
                    return Promise.all([
                        countlySodaRetentionRevenue.service.fetchRetention(filters),
                        countlySodaRetentionRevenue.service.fetchPayerRetention(filters),
                        countlySodaRetentionRevenue.service.fetchRepeatPayRetention(filters),
                        countlySodaRetentionRevenue.service.fetchRevenue(filters)
                    ]).then(function(response) {
                        context.commit('setRetention', response[0]);
                        context.commit('setPayerRetention', response[1]);
                        context.commit('setRepeatPayRetention', response[2]);
                        context.commit('setRevenue', response[3]);
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
                setRetention: function(state, value) {
                    state.retention = value;
                },
                setPayerRetention: function(state, value) {
                    state.payerRetention = value;
                },
                setRepeatPayRetention: function(state, value) {
                    state.repeatPayRetention = value;
                },
                setRevenue: function(state, value) {
                    state.revenue = value;
                }
            },
            submodules: [countlyVue.vuex.FetchMixin()]
        });
    };
}(window.countlySodaRetentionRevenue = window.countlySodaRetentionRevenue || {}));
