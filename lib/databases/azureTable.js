/**
 * Created by RICHARD Vincent on 18/02/14.
 */
var _ = require('lodash'),
    azure = require('azure-storage'),
    uuid = require('../uuid.js'),
    ConcurrencyError = require('../concurrencyError'),
    eg = azure.TableUtilities.entityGenerator,
    async = require('async');

module.exports = {
    // __connect:__ Initiate communication with the database.
    //
    // `db.connect(options, callback)`
    //
    // - __options:__ The options can have information like host, port, etc. [optional]
    // - __callback:__ `function(err, queue){}`
    connect: function (options, callback) {
        if (_.isFunction(options)) {
            callback = options;
            options = {};
        }

        var azureConf = {
            storageAccount: process.env['AZURE_STORAGE_ACCOUNT'],
            storageAccessKey: process.env['AZURE_STORAGE_ACCESS_KEY'],
            storageTableHost: process.env['AZURE_TABLE_HOST']
        };

        _.defaults(options, azureConf);

        var defaults = {
            storageAccount: "devstoreaccount1",
            storageAccessKey: "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
            storageTableHost: "http://127.0.0.1:10002",
            timeout: 1000
        };

        _.defaults(options, defaults);

        var defaultOpt = {
            auto_reconnect: true,
            ssl: false
        };

        options.options = options.options || {};
        options.options = _.defaults(options.options, defaultOpt);
        this.collectionName = options.collectionName || 'default';

        this.options = options;
        if (this.isConnected) {
            if (callback) {
                return callback(null, this);
            }
            return;
        }

        var retryOperations = new azure.ExponentialRetryPolicyFilter();

        this.isConnected = false;
        var self = this;

        this.client = azure.createTableService(options.storageAccount, options.storageAccessKey, options.storageTableHost).withFilter(retryOperations);
        //this.client.defaultPayloadFormat = azure.TableUtilities.PayloadFormat.FULL_METADATA;
        this.client.createTableIfNotExists(this.collectionName, function (err) {
            if (err) {
                if (callback) callback(err);
            }
            else {
                self.isConnected = true;
                if (callback) callback(null, self);
            }
        });
    },

    // __getNewId:__ Use this function to obtain a new id.
    //
    // `repo.getNewId(callback)`
    //
    // - __callback:__ `function(err, id){}`
    getNewId: function (callback) {
        if (callback)
            callback(null, uuid().toString());
    },

    // __get:__ Use this function to get the viewmodel.
    //
    // `repo.get(id, callback)`
    //
    // - __id:__ The id to identify the viewmodel.
    // - __callback:__ `function(err, vm){}`
    get: function (p_id, p_callback) {

        if (_.isFunction(p_id)) {
            p_callback = p_id;
            p_id = uuid().toString();
        }
        var self = this;

        var options = {};
        options.autoResolveProperties = true;
        options.entityResolver = self.generateObject;
        //options.propertyResolver = self.propertyResolver;

        async.series({isConnected: function (callback) {
                self.checkConnection(callback, self);
            },
                doGet: function (callback) {
                    self.client.retrieveEntity(self.collectionName,
                        p_id,
                        p_id,
                        options,
                        function (err, entity) {
                            if (err && err.code != 'ResourceNotFound') {
                                if (callback) return callback(err);
                            }
                            if (!entity) {
                                if (callback) return callback(null, self.getNewViewModel(p_id));
                            }
                            if (callback) callback(null, self.fromObject(entity));
                        });
                }},
            function (err, result) {
                if (err) p_callback(err, null);
                else {
                    if (result.isConnected) p_callback(null, result.doGet);
                    else throw new Error('Erreur lors de la création de la table')
                }
            });
    },

    // __find:__ Use this function to find viewmodels.
    //
    // `repo.find(query, callback)`
    //
    // - __query:__ The query to find the viewmodels.
    // - __callback:__ `function(err, vms){}`
    find: function (p_query, p_options, p_callback) {
        var self = this;
        var defaultQueryOpts = {pageSize: 25, continuationToken: null};
        if (arguments.length === 1) {
            p_callback = p_query;
            p_options = {};
            p_query = {};
        } else if (arguments.length === 2) {
            p_callback = p_options;
            if (_.has(p_query, 'pageSize') || _.has(p_query, 'continuationToken') || _.has(p_query, 'pageMode')) {
                p_options = p_query;
                p_query = {}
            } else {
                p_options = {}
            }
        }

        _.defaults(p_options, defaultQueryOpts);

        var options = {};
        options.autoResolveProperties = true;
        options.entityResolver = self.generateObject;

        var tableQuery = new azure.TableQuery();

        var queryTerms = _.map(p_query, function (queryValue, queryKey) {
            if (_.isArray(queryValue)) {
                return _.map(queryValue, function (qV) {
                    qV = self.defaultQueryValues(qV);
                    return {key: queryKey + ' ' + qV.operator + ' ?', value: qV.value}
                });
            } else {
                queryValue = self.defaultQueryValues(queryValue);
                return {key: queryKey + ' ' + queryValue.operator + ' ?', value: queryValue.value}
            }
        });
        queryTerms = _.flatten(queryTerms);

        for (var i = 0; i < queryTerms.length; i++) {
            if (i == 0) tableQuery = tableQuery.where(queryTerms[i].key, queryTerms[i].value);
            else tableQuery = tableQuery.and(queryTerms[i].key, queryTerms[i].value);
        }
        if (p_options.pageMode != 'full') {
            tableQuery.top(p_options.pageSize);
        }

        async.series({isConnected: function (callback) {
                self.checkConnection(callback, self);
            },
                doFind: function (callback) {
                    var entities = [];
                    var continuationToken = p_options.continuationToken;
                    async.doWhilst(function (cb) {
                        // retrieve entities
                        self.client.queryEntities(self.collectionName, tableQuery, continuationToken, options, function (err, results) {
                                if (err) {
                                    cb(err);
                                }
                                else {
                                    continuationToken = results.continuationToken;
//                                    if (results.continuationToken) {
//                                        continuationToken = results.continuationToken;
//                                        //resultToken = new Buffer(JSON.stringify(results.continuationToken)).toString('base64');
//                                    }
                                    results = _.map(results.entries, function (value) {
                                        return self.fromObject(value);
                                    });
                                    entities = entities.concat(results);
                                    cb(null);
                                }
                            }
                        );
                    }, function () {
                        // test if we need to load more
                        return (p_options.pageMode == 'full' || entities.length < p_options.pageSize) ? continuationToken !== null : false;

                    }, function (err) {
                        // return results
                        if (err) callback(err);
                        else {
                            var cT = continuationToken ? new Buffer(JSON.stringify(continuationToken)).toString('base64') : null;
                            callback(null, {entities: entities, continuationToken: cT});
                        }
                    })
                }
            },
            function (err, result) {
                if (err)
                    p_callback(err, null);
                else {
                    if (result.isConnected) p_callback(null, result.doFind);
                    else throw new Error('Problème de connection');
                }
            }
        );
    },

// __commit:__ Use this function to commit a viewmodel.
//
// `repo.commit(vm, callback)`
//
// - __vm:__ The viewmodel that should be commited.
// - __callback:__ `function(err){}`
    commit: function (p_vm, p_callback) {

        var self = this;
        async.series({isConnected: function (callback) {
                self.checkConnection(callback, self);
            },
                doCommit: function (callback) {
                    if (!p_vm.actionOnCommit && callback) callback(new Error('ViewModel must have an actionOnCommit.'));
                    var objDescriptor = {PartitionKey: eg.String(self.options.partitionKey ? self.options.partitionKey : p_vm.id),
                        RowKey: eg.String(p_vm.id)};
                    var obj;
                    switch (p_vm.actionOnCommit) {
                        case 'delete':

                            self.client.deleteEntity(self.collectionName, objDescriptor, function (err) {
                                if (err) {
                                    if (callback) callback(err);
                                } else {
                                    if (callback) callback(null);
                                }
                            });
                            break;
                        case 'create':
                            obj = self.fromViewModel(p_vm);
                            obj = self.generateEntity(obj);
                            self.client.insertEntity(self.collectionName, _.assign(obj, objDescriptor), function (err) {
                                if (err) {
                                    if (err.code == 'EntityAlreadyExists') err = new ConcurrencyError();
                                    if (callback) callback(err);
                                } else {
                                    p_vm.actionOnCommit = 'update';
                                    if (callback) callback(null, p_vm);
                                }
                            });
                            break;
                        case 'update':
                            obj = self.fromViewModel(p_vm);
                            obj = self.generateEntity(obj);
                            if (typeof p_vm['.metadata'] === 'undefined') {
                                self.client.insertEntity(self.collectionName, _.assign(obj, objDescriptor), function (err) {
                                    if (err) {
                                        if (err.code == 'EntityAlreadyExists') err = new ConcurrencyError();
                                        if (callback) callback(err);
                                    } else {
                                        p_vm.actionOnCommit = 'update';
                                        if (callback) callback(null, p_vm);
                                    }
                                })
                            } else {
                                _.merge(objDescriptor, {etag: p_vm['.metadata'].etag });
                                self.client.updateEntity(self.collectionName, _.assign(obj, objDescriptor), {checkEtag: true}, function (err) {
                                    if (err) {
                                        if (err.code == 'ConditionNotMet' && err.statusCode == 412) err = new ConcurrencyError();
                                        if (callback) callback(err);
                                    } else {
                                        if (callback) callback(null, p_vm);
                                    }
                                });
                                /*                            self.client.insertOrReplaceEntity(self.collectionName, _.assign(obj, objDescriptor), function (err) {
                                 if (err) {
                                 if (callback) callback(err);
                                 } else {
                                 if (callback) callback(null, p_vm);
                                 }
                                 });*/
                            }
                            break;
                        default:
                            if (callback)
                                callback(new Error('viewModel\'s actionOnCommit must be \'delete\', \'create\', or \'update\''));
                            break;
                    }
                }},
            function (err, result) {
                if (err) p_callback(err, null);
                else {
                    if (result.isConnected) p_callback(null, result.doCommit);
                    else throw new Error('Erreur lors de la connexion');
                }

            });

    },

// __checkConnection:__ Use this function to check if all is initialized correctly.
//
// `this.checkConnection()`
    checkConnection: function (callback, thisArgs) {
        thisArgs.client.createTableIfNotExists(thisArgs.collectionName, function (err) {
            if (err) callback(err, null);
            else callback(null, true);
        });
    },

// __extend:__ Use this function to extend this repository with the appropriate collectionName.
//
// `repo.extend(obj)`
//
// - __obj:__ The object that should be extended.
    extend: function (obj) {
        var res = _.assign(_.assign({}, this), obj);
        for (var f in this) {
            if (_.isFunction(this[f])) {
                res[f] = this[f];
            }
        }
        return res;
    },

    generateEntity: function (obj) {
        var entity = _.clone(obj);
        for (var property in entity) {
            if (property !== '.metadata') {
                if (_.isArray(entity[property])) {
                    entity[property] = JSON.stringify(entity[property]);
                }
                if (_.isObject(entity[property])) {
                    entity[property] = JSON.stringify(entity[property]);
                }
                switch (typeof entity[property]) {
                    case 'string':
                        entity[property] = eg.String(entity[property]);
                        break;
                    case 'boolean':
                        entity[property] = eg.Boolean(entity[property]);
                        break;
                    case 'number':
                        entity[property] = eg.Int32(entity[property]);
                        break;
                    default:
                        entity[property] = eg.Entity(entity[property]);
                }
            }
        }
        return entity;
    },

    generateObject: function (entity) {
        var obj = _.clone(entity);

        var IsJsonString = function IsJsonString(str) {
            try {
                JSON.parse(str);
            } catch (e) {
                return false;
            }
            return true;
        };

        for (var property in obj) {
            if (property !== '.metadata') {
                if (IsJsonString(obj[property]['_'])) {
                    obj[property]['_'] = JSON.parse(obj[property]['_']);
                    if (!_.isArray(obj[property]['_'])
                        && !_.isObject(obj[property]['_'])
                        && obj[property]['$']
                        && obj[property]['$'] == 'Edm.String') {
                        obj[property]['_'] = obj[property]['_'].toString();
                    }
                }
                obj[property] = obj[property]['_'];
            }
        }
        return obj;
    },

    propertyResolver: function (pk, rk, name, value) {
        if (name.indexOf('BinaryField') !== -1) {
            return 'Edm.Binary';
        } else if (name.indexOf('GuidField') !== -1) {
            return 'Edm.Guid';
        } else if (name.indexOf('DateField') !== -1) {
            return 'Edm.DateTime';
        } else if (name.indexOf('DoubleField') !== -1) {
            return 'Edm.Double';
        }
        return 'Edm.String';
    },

    defaultQueryValues: function (queryValue) {
        var IsJsonString = function IsJsonString(str) {
            var parsed = true;
            try {
                parsed = JSON.parse(str);
            } catch (e) {
                return false;
            }
            return _.isObject(parsed);
        };

        if (IsJsonString(queryValue)) {
            queryValue = JSON.parse(queryValue);
        } else {
            queryValue = {value: queryValue, operator: 'eq'};
        }
        return _.defaults(queryValue, {operator: 'eq'});
    }
}
;