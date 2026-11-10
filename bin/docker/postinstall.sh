#!/bin/bash

PLUGIN_LIST=",${COUNTLY_PLUGINS},"

if [ -f /opt/countly/plugins/plugins.json ] && [[ "$PLUGIN_LIST" != *,drill,* ]] && [[ "$PLUGIN_LIST" != *,custom-drill,* ]]; then
	echo "[docker] Plugins have been built, skipping rebuilding"
else
	if [ -z "$COUNTLY_PLUGINS" ]; then
 		cp /opt/countly/plugins/plugins.default.json /opt/countly/plugins/plugins.json
		echo "[docker] Using default plugins.json"
  		cat /opt/countly/plugins/plugins.json
	else
		echo "[docker] Using COUNTLY_PLUGINS: $COUNTLY_PLUGINS"
		PLUGIN_LIST=",${COUNTLY_PLUGINS},"
		if [[ "$PLUGIN_LIST" == *,drill,* ]] && [[ "$PLUGIN_LIST" != *,license,* ]]; then
			if [[ "$COUNTLY_PLUGINS" == "drill" ]]; then
				COUNTLY_PLUGINS="license,drill"
			else
				COUNTLY_PLUGINS=${COUNTLY_PLUGINS//,drill/,license,drill}
			fi
			echo "[docker] added license plugin: $COUNTLY_PLUGINS"
		fi

		a=$(echo "$COUNTLY_PLUGINS" | tr ',' '\n')
		printf %s\\n "${a[@]}"|sed 's/["\]/\\&/g;s/.*/"&"/;1s/^/[/;$s/$/]/;$!s/$/,/' > /opt/countly/plugins/plugins.json
  	fi

    #load city data into database
    node "/opt/countly/bin/scripts/loadCitiesInDb.js"
fi
