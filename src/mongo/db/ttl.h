/**
 *    Copyright (C) 2018-present MongoDB, Inc.
 *
 *    This program is free software: you can redistribute it and/or modify
 *    it under the terms of the Server Side Public License, version 1,
 *    as published by MongoDB, Inc.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    Server Side Public License for more details.
 *
 *    You should have received a copy of the Server Side Public License
 *    along with this program. If not, see
 *    <http://www.mongodb.com/licensing/server-side-public-license>.
 *
 *    As a special exception, the copyright holders give permission to link the
 *    code of portions of this program with the OpenSSL library under certain
 *    conditions as described in each individual source file and distribute
 *    linked combinations including the program with the OpenSSL library. You
 *    must comply with the Server Side Public License in all respects for
 *    all of the code used other than as permitted herein. If you modify file(s)
 *    with this exception, you may extend this exception to your version of the
 *    file(s), but you are not obligated to do so. If you do not wish to do so,
 *    delete this exception statement from your version. If you delete this
 *    exception statement from all source files in the program, then also delete
 *    it in the license file.
 */

#pragma once

#include "mongo/db/ttl_collection_cache.h"
#include "mongo/util/background.h"

namespace mongo {

class ServiceContext;

/**
 * Instantiates the TTLMonitor to periodically remove documents from TTL collections. Safe to call
 * again after shutdownTTLMonitor() has been called.
 */
void startTTLMonitor(ServiceContext* serviceContext);

/**
 * Shuts down the TTLMonitor if it is running. Safe to call multiple times.
 */
void shutdownTTLMonitor(ServiceContext* serviceContext);

class TTLMonitor : public BackgroundJob {
public:
    explicit TTLMonitor() : BackgroundJob(false /* selfDelete */) {}

    static TTLMonitor* get(ServiceContext* serviceCtx);

    static void set(ServiceContext* serviceCtx, std::unique_ptr<TTLMonitor> monitor);

    std::string name() const {
        return "TTLMonitor";
    }

    void run();

    /**
     * Signals the thread to quit and then waits until it does.
     */
    void shutdown();

private:
    /**
     * Gets all TTL specifications for every collection and deletes expired documents.
     */
    void _doTTLPass();

    /**
     * Uses the TTL 'info' to determine which documents are expired and removes them from the
     * collection when applicble. In some cases (i.e: on temporary resharding collections,
     * collections pending to be dropped, etc), the TTLMonitor is prohibitied from removing
     * documents and the method silently returns.
     */
    void _deleteExpired(OperationContext* opCtx,
                        TTLCollectionCache* ttlCollectionCache,
                        const UUID& uuid,
                        const NamespaceString& nss,
                        const TTLCollectionCache::Info& info);

    /**
     * Removes documents from the collection using the specified TTL index after a sufficient
     * amount of time has passed according to its expiry specification.
     */
    void _deleteExpiredWithIndex(OperationContext* opCtx,
                                 TTLCollectionCache* ttlCollectionCache,
                                 const CollectionPtr& collection,
                                 std::string indexName);

    /*
     * Removes expired documents from a clustered collection using a bounded collection scan.
     * On time-series buckets collections, TTL operates on type 'ObjectId'. On general purpose
     * collections, TTL operates on type 'Date'.
     */
    void _deleteExpiredWithCollscan(OperationContext* opCtx,
                                    TTLCollectionCache* ttlCollectionCache,
                                    const CollectionPtr& collection);

    // Protects the state below.
    mutable Mutex _stateMutex = MONGO_MAKE_LATCH("TTLMonitorStateMutex");

    // Signaled to wake up the thread, if the thread is waiting. The thread will check whether
    // _shuttingDown is set and stop accordingly.
    mutable stdx::condition_variable _shuttingDownCV;

    bool _shuttingDown = false;
};

}  // namespace mongo
