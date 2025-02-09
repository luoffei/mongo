/**
 * Tests for the connPoolStats command.
 *
 * @tags: [requires_fcv_53]
 */
load("jstests/libs/fail_point_util.js");
load("jstests/libs/conn_pool_helpers.js");

(function() {
"use strict";

let st = new ShardingTest({shards: 1});

// Run the connPoolStats command
let stats = st.s.getDB("admin").runCommand({connPoolStats: 1});

// Check whether Cluster Connection Health Metrics feature flag is enabled
const isCCHMEnabled = st.s.getDB("admin")
                          .runCommand({getParameter: 1, featureFlagConnHealthMetrics: 1})
                          .featureFlagConnHealthMetrics.value;

// Validate output
printjson(stats);
assert.commandWorked(stats);
assert("replicaSets" in stats);
assert("hosts" in stats);
assert("numClientConnections" in stats);
assert("numAScopedConnections" in stats);
assert("totalInUse" in stats);
assert("totalAvailable" in stats);
assert("totalCreated" in stats);
assert.lte(stats["totalInUse"] + stats["totalAvailable"], stats["totalCreated"], tojson(stats));

assert("pools" in stats);
assert("totalRefreshing" in stats);
assert.lte(stats["totalInUse"] + stats["totalAvailable"] + stats["totalRefreshing"],
           stats["totalCreated"],
           tojson(stats));

assert("totalRefreshed" in stats);

function neverUsedMetricTest(kDbName = 'test') {
    const mongos = st.s0;
    const primary = st.rs0.getPrimary();
    const mongosDB = mongos.getDB(kDbName);

    const cfg = primary.getDB('local').system.replset.findOne();
    const allHosts = cfg.members.map(x => x.host);
    const primaryOnly = [primary.name];

    let currentCheckNum = 0;
    let toRefreshTimeoutMS = 1000;
    let threads = [];

    [1, 2, 3].forEach(v => assert.commandWorked(mongosDB.test.insert({x: v})));
    st.rs0.awaitReplication();

    // Bump up number of pooled connections to 15
    assert.commandWorked(mongos.adminCommand({
        "setParameter": 1,
        ShardingTaskExecutorPoolMinSize: 15,
        ShardingTaskExecutorPoolRefreshRequirementMS: toRefreshTimeoutMS
    }));

    // Launch 5 blocked finds and verify that 5 connections are in-use while the remaining 10 are
    // available
    configureReplSetFailpoint(st, kDbName, "waitInFindBeforeMakingBatch", "alwaysOn");
    launchFinds(mongos, threads, {times: 5, readPref: "primary"}, currentCheckNum);
    currentCheckNum = assertHasConnPoolStats(
        mongos, allHosts, {active: 5, ready: 10, hosts: primaryOnly}, currentCheckNum);

    // Reduce pool size to drop some available connections, verify that these were never used to
    // run an operation during their lifetime
    assert.commandWorked(mongos.adminCommand({
        "setParameter": 1,
        ShardingTaskExecutorPoolMinSize: 7,
        ShardingTaskExecutorPoolMaxSize: 7
    }));
    currentCheckNum = assertHasConnPoolStats(
        mongos,
        allHosts,
        {
            hosts: primaryOnly,
            checkStatsFunc: function(stats) {
                return stats.available == 2 && stats.inUse == 5 && stats.wasNeverUsed == 8;
            }
        },
        currentCheckNum);
    configureReplSetFailpoint(st, kDbName, "waitInFindBeforeMakingBatch", "off");
    threads.forEach(t => t.join());

    // stats = st.s.getDB("admin").runCommand({connPoolStats: 1});
    // assert.eq(stats["totalWasNeverUsed"], 8);
}

if (isCCHMEnabled) {
    neverUsedMetricTest();
}

// Enable the following fail point to refresh connections after every command.
let refreshConnectionFailPoint =
    configureFailPoint(st.s.getDB("admin"), "refreshConnectionAfterEveryCommand");

let latestTotalRefreshed = stats["totalRefreshed"];

// Iterate over totalRefreshed stat to assert it increases over time.
const totalIterations = 5;
for (let counter = 1; counter <= totalIterations; ++counter) {
    jsTest.log("Testing totalRefreshed, iteration " + counter);
    // Issue a find command to force a connection refresh
    st.s.getDB("admin").runCommand({"find": "hello world"});
    assert.soon(function() {
        stats = st.s.getDB("admin").runCommand({connPoolStats: 1});
        assert.commandWorked(stats);
        const result = latestTotalRefreshed < stats["totalRefreshed"];
        jsTest.log(tojson({
            "latest total refreshed": latestTotalRefreshed,
            "current total refreshed": stats["totalRefreshed"]
        }));
        latestTotalRefreshed = stats["totalRefreshed"];
        return result;
    }, "totalRefreshed stat did not increase within the expected time", 5000);
}

refreshConnectionFailPoint.off();

st.stop();
})();
