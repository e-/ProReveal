import * as util from '../util';
import { Dataset, Row } from '../data/dataset';
import { Query, AggregateQuery, SelectQuery } from '../data/query';
import { Scheduler, QueryOrderScheduler } from '../data/scheduler';
import { Schema } from '../data/schema';
import { Predicate } from '../data/predicate';
import { Priority } from './priority';
import * as io from 'socket.io-client';
import { RemoteSampler } from '../data/sampler';


export class RemoteEngine {
    rows: Row[];
    dataset: Dataset;
    schema: Schema;
    queries: Query[] = []; // all queries (order is meaningless)
    ongoingQueries: Query[] = [];
    completedQueries: Query[] = [];
    scheduler: Scheduler = new QueryOrderScheduler(this.ongoingQueries);
    queryDone: (query: Query) => void;
    selectQueryDone: (query: SelectQuery) => void;
    runningQuery: Query;
    isRunning = true;
    autoRun = false;
    activeTId: number;
    ws: SocketIOClient.Socket;
    info: any;

    constructor(public url: string) {
        let ws = io(url, { transports: ['websocket'] })

        this.ws = ws;

        ws.on('welcome', (serverInfo: any) => {
            this.info = serverInfo;
        })

        ws.on('disconnect', (reason) => {
            console.log(reason)
            this.info = null;
        })

        ws.on('RES/query', (data:any) => {
            console.log('new query created', data)
            const querySpec = data.query;
            const query = Query.fromJSON(querySpec, this.dataset);

            this.queries.push(query);
            this.ongoingQueries.push(query); // TODO we want to remove ongoing queries
        });

        ws.on('result', (data: any) => {
            console.log('Result arrived', data)

            const query = this.ongoingQueries.find(q => q.id === data.query.id) as AggregateQuery;
            if(!query) return; // query removed

            let aggregateKeyValues = query.convertToAggregateKeyValues(data.query.result);

            query.lastUpdated = data.query.lastUpdated;
            query.recentProgress.processedRows = data.query.numProcessedRows;
            query.recentProgress.processedBlocks = data.query.numProcessedBlocks;
            query.recentResult = {};

            aggregateKeyValues.forEach(kv => {
                query.recentResult[kv.key.hash] = kv;
            });

            if(query.updateAutomatically) query.sync();

            this.queryDone(query);
        })

        ws.on('STATUS/job/start', (data:any) => {
            const id = data.id;
            const query = this.queries.find(q => q.id == id);
            console.log('job start',  data)

            this.runningQuery = query;
            query.recentProgress.ongoingBlocks = data.numOngoingBlocks;
            query.recentProgress.ongoingRows = data.numOngoingRows;
        })

        ws.on('STATUS/job/end', (data:any) => {
            const id = data.id;
            const clientId = data.clientId;

            if(this.runningQuery && (this.runningQuery.id == id || this.runningQuery.id == clientId))
            {
                this.runningQuery.recentProgress.ongoingBlocks = 0;
                this.runningQuery.recentProgress.ongoingRows = 0;
                this.runningQuery = null;
            }
        })
    }

    restore(code: string): Promise<[Dataset, Schema]> {
        let ws = this.ws;

        return new Promise((resolve) => {
            ws.emit('REQ/restore', {code: code});
            ws.on('RES/restore', (data: any) => {
                console.log('Restored the session', data);

                const schema = data.metadata.schema;
                const numRows = data.metadata.numRows;
                const numBatches = data.metadata.numBatches;

                this.schema = new Schema(schema);
                this.dataset = new Dataset(data.metadata.name, this.schema, [],
                    new RemoteSampler(numRows, numBatches));

                console.log('Got schema', schema);

                resolve([this.dataset, this.schema]);

                // restore queries

                data.session.queries.forEach(querySpec => {
                    const query = Query.fromJSON(querySpec, this.dataset);

                    this.queries.push(query);
                    this.ongoingQueries.push(query)
                })
            });
        });
    }

    run() { }
    runOne() { }

    emit(event: string) {
        this.ws.emit(event);
    }

    request(query: Query, priority: Priority = Priority.Highest) {
        // TODO scheduling required
        // recent to end
        if (priority === Priority.Highest) {
            this.ongoingQueries.unshift(query);
        }
        else if (priority === Priority.Lowest) {
            this.ongoingQueries.push(query);
        }

        // this.queries.push(query);

        this.ws.emit('REQ/query', {query: query.toJSON()}) //, queue: this.queueToJSON()})
    }

    pauseQuery(query: Query) {
        query.pause();
        this.ws.emit('REQ/query/pause', {query: query.toJSON(), queue: this.queueToJSON()})
    }

    pauseAllQueries() {
        this.ongoingQueries.forEach(query => {
            this.pauseQuery(query);
        });
    }

    resumeQuery(query: Query) {
        query.resume();
        this.ws.emit('REQ/query/resume', {query: query.toJSON(), queue: this.queueToJSON()})
    }

    resumeAllQueries() {
        this.ongoingQueries.forEach(query => {
            this.resumeQuery(query);
        });
    }

    remove(query: Query) {
        util.aremove(this.ongoingQueries, query);
        util.aremove(this.completedQueries, query);

        this.ws.emit('REQ/query/delete', query.toJSON());
    }

    reorderOngoingQueries(queries: Query[]) {
        let order = {};
        queries.forEach((q, i) => order[q.id] = i + 1);
        let n = this.ongoingQueries.length;
        this.ongoingQueries.sort((a, b) => {
            return (order[a.id] || n) - (order[b.id] || n);
        });

        this.ws.emit('REQ/queue/reschedule', this.queueToJSON())
    }

    reschedule(scheduler?: Scheduler) {
        if(scheduler) this.scheduler = scheduler;

        this.ws.emit('REQ/queue/reschedule', this.queueToJSON())
    }

    select(where: Predicate): void {
        let query = new SelectQuery(this.dataset, where);
        this.ws.emit('REQ/query', {query: query.toJSON(), queue: this.queueToJSON()})
    }

    queueToJSON() {
        return {
            mode: this.scheduler.name,
            queries: this.ongoingQueries.map(q => q.toJSON())
        }
    }
}
