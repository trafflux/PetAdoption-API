function MongoDB(instanceOptions) {
    var util = require('util'),
        path = require('path'),
        fs = require('fs'),

        mongoose = require('mongoose'),
        _ = require('lodash'),
        async = require('async'),

        config = require('../../config'),
        dump = require('../../../lib/dump'),
        dbUtils = require('./utils'),

        self = this,
        localConfig = (function () {
            var config = {
                username: 'username',
                password: 'password',
                domain: 'example.com',
                port: 'port',
                database: 'no_database_provided'
            };
            try {
                //override template config with local json file data
                config = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'mongodb.config')));
            } catch (e) {
                console.error(e);
            }
            return config;
        })();


    this.adapter = mongoose;

    this.identity = {
        username: process.env.username || localConfig.username,
        password: process.env.password || localConfig.password,
        domain: process.env.domain || localConfig.domain,
        port: process.env.port || localConfig.port,
        database: process.env.database || localConfig.database
    };

    this.state = {
        isConnecting: false,
        isConnected: false
    };
    this.config = _.extend({
        retryTimeout: 2000,
        isDevelopment: config.isDevelopment,
        petTypes: ['cat', 'dog'],
        defaultSpecies: 'dog',
        queryOptions: {
            complete: function (err) {
                if (config.debugLevel > config.DEBUG_LEVEL_LOW) console.warn(err);
                return err;
            }
        }
    }, instanceOptions);

    this.errors = {
        species: (function () {
            var err = new Error("Must use valid species");
            err.status = 404;
            return err;
        })()
    };

    this.metaInfo = {
        docNames: (function () {
            var dbDocumentNames = {};
            _.forEach(self.config.petTypes, function (petType, index) {
                dbDocumentNames[petType] = util.format('pets_model_%s_%s', petType, (self.config.isDevelopment) ? 'test' : 'production')
            });
            return dbDocumentNames;
        })(),
        dbName: (self.config.isDevelopment) ? 'pets_test' : 'pets_production'
    };
    this.queue = [];


    this.localData = {
        models: (function () {
            try {
                return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/models.json'), {encoding: 'utf8'}))
            } catch (e) {
                console.error(e);
                return {};
            }
        })(),
        schemas: (function () {
            try {
                return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data/schema.json'), {encoding: 'utf8'}))
            } catch (e) {
                console.error(e);
                return {};
            }
        })()
    };

    this.schemasCollection = this.localData.schemas;


    this.modelsCollection = {
        // init without any species models
    };

    this.AnimalDatabases = {
        // init without any databases to search from
    };
    this.ModelDatabases = {
        // init without any databases to search from
    };

    this._connect = function (callback, options) {
        this.state.isConnecting = true;
        var mongodbURL = util.format("mongodb://%s:%s@%s:%s/%s", this.identity.username, this.identity.password, this.identity.domain, this.identity.port, this.identity.database);
        if (config.debugLevel > config.DEBUG_LEVEL_LOW) console.log('mongodb is connecting to %s', mongodbURL);
        this.adapter.connect(mongodbURL);
        var db = this.adapter.connection,
            _options = _.defaults(options, {
                context: null,
                loadFromLocalFile: false
            });

        db.on('error', console.error.bind(console, 'connection error:'));

        db.once('open', function () {

            if (config.debugLevel > config.DEBUG_LEVEL_LOW) console.log('Running in %s mode.', (self.config.isDevelopment) ? 'dev' : 'production');

            async.eachSeries(self.config.petTypes,
                function each(petType, done) {
                    // init animals db document for given petType
                    self.AnimalDatabases[petType] = mongoose.model(petType, new mongoose.Schema(self.schemasCollection[petType]), self.metaInfo.dbName);

                    // init given petType's model db document
                    var animalModelSchema = dbUtils.buildModelSchema(self.schemasCollection[petType]);
                    self.ModelDatabases[petType] = mongoose.model(util.format('%s-model', petType), new mongoose.Schema(animalModelSchema), self.metaInfo.docNames[petType]);

                    // find last saved model
                    self.ModelDatabases[petType].find({})
                        .sort({timestamp: -1})
                        .limit(1)
                        .exec(function (err, foundAnimalModels) {
                            if (err || foundAnimalModels.length == 0 || _options.loadFromLocalFile) {
                                // use local hardcoded version on failure to find model in db
                                err.status = 500;
                                console.error(err || new Error('No models found'));
                                console.warn('creating new %s model', petType);

                                var hardcodedAnimalModel = self.localData.models;
                                self.modelsCollection[petType] = hardcodedAnimalModel[petType];
                                self.modelsCollection[petType]['timestamp'] = Date.now();

                                self.ModelDatabases[petType].create(self.modelsCollection[petType], function (err, newlySavedAnimalModel) {
                                    self.modelsCollection[petType] = self._formatModelOutput(newlySavedAnimalModel);
                                    done(err);
                                });
                            } else {
                                self.modelsCollection[petType] = self._formatModelOutput(foundAnimalModels[0]); // foundAnimalModels is an array of 1 model due to the limit set in the query
                                if (config.debugLevel >= config.DEBUG_LEVEL_MED) console.log('%s model initialization complete', petType);
                                done();
                            }
                        });

                }, function complete(err) {
                    if (err) throw err;
                    self.state.isConnected = true;
                    self.state.isConnecting = false;
                    fs.writeFile(path.resolve(process.cwd(), 'data/models.json'), JSON.stringify(self.modelsCollection), function (localWriteErr) {
                        if (localWriteErr) console.error(localWriteErr);
                        if (config.debugLevel > config.DEBUG_LEVEL_LOW) console.log('models initialization complete');
                        if (_.isFunction(callback)) callback.apply(_options.context, [self, _options]);
                    });
                });
        });
    };

    /**
     *
     * @param func
     * @param [options]
     * @param options.context
     * @private
     */
    this._exec = function (func, options) {
        var _options = _.defaults(options, {
            context: self
        });
        if (!_.isFunction(func)) {
            console.warn('mongodb._exec() - no function passed');
            return;
        }
        this.queue.push({
            callback: func,
            options: _options
        });

        function onConnected() {
            var callback,
                callbackOptions;
            while (self.queue.length > 0) {
                callback = self.queue[0].callback;
                callbackOptions = self.queue[0].options;
                callback.apply(callbackOptions.context, [self, callbackOptions]);
                self.queue.shift();
            }
        }

        if (this.state.isConnected) {
            onConnected();
        } else if (this.state.isConnecting) {
            if (_options.debug >= config.DEBUG_LEVEL_LOW) console.log('MongoDB is connecting...');
        } else {
            if (_options.debug >= config.DEBUG_LEVEL_LOW) console.log('MongoDB is starting up...');
            this._connect(onConnected);
        }
    };

    /**
     * Builds search object from provided animalProps object. animalProps is an object of fields corresponding to one of the animal schemas
     * @param {Object} searchProps
     * @returns {Object}
     * @private
     */
    this._buildQuery = function (searchProps) {
        var animalProps = {
                species: this._getSpeciesFromProps(searchProps)
            },
            sanitizedSearchProps = this._buildSearchParams(searchProps),
            propValue;

        _.forEach(sanitizedSearchProps, function (propData, propName, collection) {
            propValue = propData.val || propData; // check if data has been sent as a v1 or v2 structure
            switch (propName) {
                case 'petId':
                case 'hashId':
                case '_id':
                    // only use given id and quit early
                    animalProps = {'_id': propValue};
                    console.log('searching by id: %s', propValue);
                    return false;
                case 'species':
                    // ignore because species was already set
                    break;
                default:
                    if (self.modelsCollection[animalProps.species][propName]) {
                        if (self.modelsCollection[animalProps.species][propName].valType == 'String') {
                            var prefix = '',
                                suffix = '',
                                regexArgs = '';
                            if (sanitizedSearchProps['matchStartFor'] && _.indexOf(sanitizedSearchProps['matchStartFor'], propName) >= 0) {
                                prefix = '^';
                            }
                            if (sanitizedSearchProps['matchEndFor'] && _.indexOf(sanitizedSearchProps['matchEndFor'], propName) >= 0) {
                                suffix = '$';
                            }
                            if (sanitizedSearchProps['ignoreCaseFor'] && _.indexOf(sanitizedSearchProps['ignoreCaseFor'], propName) >= 0) {
                                regexArgs = 'i';
                            }
                            if (self.schemasCollection[animalProps.species][propName]) {
                                animalProps[propName] = new RegExp(util.format('%s%s%s', prefix, dbUtils.escapeRegExp(propValue), suffix), regexArgs);
                            }
                        } else {
                            animalProps[propName] = propValue;
                        }
                    }
                    break;
            }
        });
        return animalProps;
    };

    this._getSpeciesFromProps = function (animalProps) {

        var species;
        if (_.isString(animalProps['species'])) {
            // check v2 format
            species = animalProps['species'].toLowerCase()
        } else if (animalProps['species'] && animalProps['species'].val) {
            // check v1 format
            species = animalProps['species'].val.toLowerCase()
        } else {
            return false;
        }
        return (self.schemasCollection[species]) ? species : false;
    };

    this._getSpeciesFromModel = function (animalModelProps) {

        var species;

        if (!animalModelProps['species']) return false;

        if (_.isString(animalModelProps['species'].val)) {
            species = animalModelProps['species'].val.toLowerCase()
        } else if (_.isString(animalModelProps['species'].defaultVal)) {
            species = animalModelProps['species'].defaultVal.toLowerCase()
        } else {
            return false
        }
        return (self.modelsCollection[species]) ? species : false;
    };

    this._buildSearchParams = function (queryProps) {
        var filteredQueryProps = {species: this._getSpeciesFromProps(queryProps)};
        if (queryProps['petId']) {
            filteredQueryProps['_id'] = "000000000000000000000000";
            if (/^[0-9a-fA-F]{24}$/.test(queryProps['petId'])) {
                // petId provided
                filteredQueryProps['_id'] = queryProps['petId'];
            }
        }
        filteredQueryProps = this._sanitizeDBInput(queryProps);
        delete queryProps['petId'];
        return _.defaults(filteredQueryProps, queryProps);
    };

    this._sanitizeDBInput = function (animalProps) {
        var sanitizedProps = {},
            animalSpecies = this._getSpeciesFromProps(animalProps),
            schema = self.schemasCollection[animalSpecies];

        if (config.debugLevel >= config.DEBUG_LEVEL_LOW) console.log('sanitizing input with schema for %s', animalSpecies);

        _.forEach(animalProps, function (propValue, propName) {
            if (schema[propName]) {
                switch (schema[propName].valType) {
                    case 'Float':
                    case 'Location':
                    case 'Number':
                        sanitizedProps[propName] = parseFloat(propValue) || -1;
                        break;
                    case 'Date':
                        sanitizedProps[propName] = new Date(propValue);
                        break;
                    default:
                        sanitizedProps[propName] = propValue;
                }
            }
        });
        sanitizedProps['species'] = animalSpecies;
        delete sanitizedProps._id;
        return sanitizedProps;
    };

    this._formatOutput = function (animalProps, options) {
        var _options = _.extend(options, {
                isV1Format: true
            }),
            sanitizedAnimalProps = {},
            species = this._getSpeciesFromProps(animalProps),
            model = self.modelsCollection[species];

        if (config.debugLevel > config.DEBUG_LEVEL_WAY_TMI) console.log("mongodb._sanitizePetOutput() - formatting %s with: ", species, self.modelsCollection[species]);
        // format to model structure
        _.forEach(model, function (propData, propName) {
            if (_.isUndefined(animalProps[propName])) return;
            sanitizedAnimalProps[propName] = (_options.isV1Format) ? _.extend({}, model[propName], {
                val: animalProps[propName]
            }) : animalProps[propName];
        });
        sanitizedAnimalProps['petId'] = ((_options.isV1Format)) ? _.extend({}, model['petId'], {
            val: animalProps['_id']
        }) : animalProps['_id'];

        return sanitizedAnimalProps;
    };

    this._formatModelOutput = function (modelDoc) {
        var _model = (_.isFunction(modelDoc.toObject)) ? modelDoc.toObject() : modelDoc;
        return _.omit(_model, ['__v', '_id', 'timestamp'])
    };

    /**
     *
     * @param animalProps
     * @param {Object} options
     * @param {Boolean} [options.debug] Whether to log debug info
     * @param {Function} options.complete callback on operation completion
     * @param {Object} [options.context] context for complete function callback
     */
    this.removeAnimal = function (animalProps, options) {
        var _options = _.defaults(options, self.config.queryOptions);

        this._exec(function () {
            if (_options.debug >= config.DEBUG_LEVEL_MED) console.log("mongodb.removeAnimal() - received query for: ", animalProps);

            var searchableProps = this._buildSearchParams(animalProps);

            if (!searchableProps.species) return _options.complete.call(null, self.errors.species);

            if (_options.debug >= config.DEBUG_LEVEL_MED) console.log('mongodb.removeAnimal() - searching for: ', searchableProps);
            self.AnimalDatabases[searchableProps.species].remove(searchableProps, function (err, result) {
                if (err) err.status = 404;
                if (_options.debug >= config.DEBUG_LEVEL_MED) console.log('mongodb.removeAnimal() - args: %s', util.inspect(arguments));
                if (_options.complete) _options.complete.apply(null, [err, {result: (result && result.n > 0) ? 'failure' : 'success'}]);
            })
        }, options);
    };

    /**
     * @callback AnimalQueryCallback
     * @param err
     * @param animalProps
     */


    /**
     *
     * @param animalProps
     * @param {Object} options
     * @param {Boolean} [options.debug] Whether to log debug info
     * @param {AnimalQueryCallback} options.complete callback on operation completion
     * @param {Object} [options.context] context for complete function callback
     */
    this.findAnimals = function (animalProps, options) {
        var _options = _.extend(self.config.queryOptions, options);
        if (_options.debug >= config.DEBUG_LEVEL_HIGH) console.log("mongodb.findAnimals(%j)", arguments);

        var query = function () {
            if (_options.debug >= config.DEBUG_LEVEL_HIGH) console.log("mongodb.findAnimals() - received query for: ", animalProps);

            var searchParams = self._buildQuery(animalProps);

            if (!searchParams.species) return _options.complete.call(null, self.errors.species);

            if (_options.debug >= config.DEBUG_LEVEL_MED) console.log("mongodb.AnimalDatabases['%s'].findAnimals(%j)", searchParams.species, searchParams);

            self.AnimalDatabases[searchParams.species].find(
                searchParams,
                function (err, _animals) {
                    var animals = [];
                    if (err) {
                        err.status = 404;
                        console.error(err);
                    } else {
                        if (_options.debug >= config.DEBUG_LEVEL_WAY_TMI) console.log('mongodb.findAnimals() - found animals (preformatted): ', _animals);
                        _.forEach(_animals, function (animal, index) {
                            animals.push(self._formatOutput(animal));
                        })
                    }
                    if (_options.debug >= config.DEBUG_LEVEL_TMI) console.log('mongodb.findAnimals() - found animals: ', animals);
                    if (_options.complete) _options.complete.apply(_options.context, [err, animals]);
                })
        };
        this._exec(query, options);
    };

    /**
     *
     * @param animalProps
     * @param {Object} options
     * @param {Number} [options.debug] Debug output level
     * @param {AnimalQueryCallback} options.complete callback on operation completion
     * @param {Object} [options.context] context for complete function callback
     */
    this.saveAnimal = function (animalProps, options) {
        var _options = _.extend(self.config.queryOptions, options);

        this._exec(function () {
            if (_options.debug >= config.DEBUG_LEVEL_HIGH) console.log("mongodb.saveAnimal() - received post for: ", animalProps);

            var queryParams = this._buildQuery(animalProps),
                savableAnimalProps = this._sanitizeDBInput(animalProps);

            if (!queryParams.species) return _options.complete.call(null, self.errors.species);

            if (_options.debug >= config.DEBUG_LEVEL_MED) console.log('mongodb.saveAnimal() - searching for: ', queryParams);

            self.AnimalDatabases[queryParams.species].findOneAndUpdate(
                queryParams,
                savableAnimalProps, {
                    new: true,
                    upsert: true
                }, function (err, _animal) {
                    var animal = {};
                    if (err) {
                        err.status = 404;
                        console.error(err);
                    } else {
                        animal = self._formatOutput(_animal._doc);
                    }
                    if (_options.debug >= config.DEBUG_LEVEL_HIGH) console.log('saved and sending animal: ', animal);
                    if (_options.complete) _options.complete.apply(_options.context, [err, animal])
                })
        }, options);
    };

    /**
     * @callback AnimalModelQueryCallback
     * @param err
     * @param animalModel
     */

    /**
     *
     * @param animalModelProps
     * @param {Object} options
     * @param {Number} [options.debug] Debug output level
     * @param {AnimalModelQueryCallback} options.complete callback on operation completion
     * @param {Object} [options.context] context for complete function callback
     */
    this.findModel = function (animalModelProps, options) {
        var _options = _.defaults(options, self.config.queryOptions);

        this._exec(function () {
            if (_options.debug >= config.DEBUG_LEVEL_HIGH) console.log("mongodb.findModel() - received request for: ", animalModelProps);

            var species = this._getSpeciesFromModel(animalModelProps);

            if (!species) return _options.complete.call(null, self.errors.species);

            if (_options.debug >= config.DEBUG_LEVEL_MED) console.log('searching for %s model', species);

            self.ModelDatabases[species].find({})
                .sort({timestamp: -1})
                .limit(1)
                .exec(function (err, foundAnimalModels) {
                    if (err && foundAnimalModels.length > 0) {
                        err.status = 404;
                        console.error(err || new Error("No models found"));
                    } else {
                        // update active model instance
                        self.modelsCollection[species] = self._formatModelOutput(foundAnimalModels[0]);
                    }
                    if (_options.debug >= config.DEBUG_LEVEL_HIGH) console.log('mongoDb.findModel() - sending animal model: ', self.modelsCollection[species]);
                    if (_options.complete) _options.complete.apply(_options.context, [null, err || self.modelsCollection[species]]);
                });

        }, options);
    };

    /**
     *
     * @param animalModelProps
     * @param {Object} options
     * @param {Number} [options.debug] Debug output level
     * @param {AnimalModelQueryCallback} options.complete callback on operation completion
     * @param {Object} [options.context] context for complete function callback
     */
    this.saveModel = function (animalModelProps, options) {
        var _options = _.defaults(options, self.config.queryOptions);

        this._exec(function () {
            if (_options.debug == config.DEBUG_LEVEL_MED) console.log("mongodb.saveAnimalModel() - received model update ");
            if (_options.debug >= config.DEBUG_LEVEL_HIGH) console.log("mongodb.saveAnimalModel() - received model update for w/ %s", dump(animalModelProps));

            var species = this._getSpeciesFromModel(animalModelProps),
                newModel = {};

            if (!species) return _options.complete.call(null, self.errors.species);

            if (_options.debug >= config.DEBUG_LEVEL_HIGH) console.log('mongodb.saveAnimalModel() - searching for %s model', species);

            // merge newly received model with current model
            _.forEach(self.modelsCollection[species], function (currentPropData, propName) {
                newModel[propName] = _.extend({}, currentPropData, _.omit(animalModelProps[propName], ['val']));
            });
            newModel.timestamp = Date.now();

            self.ModelDatabases[species].create(newModel, function (err, _animalModel) {
                if (err) {
                    err.status = 404;
                    console.error(err);
                }

                // update active model instance
                self.modelsCollection[species] = self._formatModelOutput(_animalModel);
                if (_options.debug >= config.DEBUG_LEVEL_HIGH) console.log('saved and sending animal model: %j', self.modelsCollection[species]);


                fs.writeFile(path.resolve(process.cwd(), 'data/models.json'), JSON.stringify(self.modelsCollection), function () {
                    if (_options.debug >= config.DEBUG_LEVEL_LOW) console.log('updated cached animal model');
                    if (_options.complete) _options.complete.apply(_options.context, [err, self.modelsCollection[species]]);
                });
            });
        }, options);

        return this;
    };
}


module.exports = MongoDB;
