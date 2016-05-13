var util = require('util'),
    path = require('path'),
    fs = require('fs'),

    mongoose = require('mongoose'),
    schemaGenerator = require('mongoose-gen'),
    _ = require('lodash'),

    config = require('../config'),
    dump = require('../../lib/dump'),

    animalSchemas = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'core/data/schema.json'), {encoding: 'utf8'})),
    animalModels = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'core/data/models.json'), {encoding: 'utf8'})),
    AnimalDocs = {},
    AnimalModelDocs = {},
    defaultSpecies = 'dog',
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
            config = JSON.parse(fs.readFileSync(path.resolve('./', 'core/mongodb/mongodb.config')));
        } catch (e) {
            console.error(e);
        }
        return config;
    })(),
    mongodb = {
        adapter: mongoose,
        identity: {
            username: process.env.username || localConfig.username,
            password: process.env.password || localConfig.password,
            domain: process.env.domain || localConfig.domain,
            port: process.env.port || localConfig.port,
            database: process.env.database || localConfig.database
        },
        state: {
            isConnecting: false,
            isConnected: false
        },
        config: {
            retryTimeout: 2000,
            isDevelopment: config.isDevelopment
        },
        queue: []
    };

mongodb.connect = function (callback, options) {
    mongodb.state.isConnecting = true;
    var mongodbURL = 'mongodb://'
        + mongodb.identity.username + ':'
        + mongodb.identity.password
        + '@' + mongodb.identity.domain + ':' + mongodb.identity.port + '/'
        + mongodb.identity.database;
    console.log('mongodb is connecting to %s', mongodbURL);
    mongodb.adapter.connect(mongodbURL);
    var db = mongodb.adapter.connection,
        _options = _.extend({
            context: null
        }, options);

    db.on('error', console.error.bind(console, 'connection error:'));

    db.once('open', function () {
        mongodb.state.isConnected = true;
        mongodb.state.isConnecting = false;

        function initAnimalDocs() {
            var _animalSchemas = {};
            _.forEach(animalSchemas, function (animalSchema, animalSchemaName, collection) {
                _animalSchemas[animalSchemaName] = new mongoose.Schema(schemaGenerator.convert(animalSchema));
                AnimalDocs[animalSchemaName] = mongoose.model(animalSchemaName, _animalSchemas[animalSchemaName], (mongodb.config.isDevelopment) ? 'pets_test' : 'pets_production');
            });
        }

        function initAnimalModelDocs() {
            var _animalModelSchemas = {};
            _.forEach(animalModels, function (modelSchema, modelSchemaName, collection) {
                _animalModelSchemas[modelSchemaName] = {};
                _.forEach(modelSchema, function (propMeta, propName) {
                    switch (propMeta.type) {
                        case '[Image]':
                            propMeta.type = [String];
                            break;
                        case 'Number':
                        case 'Location':
                            if(propName == 'petId' || propName == 'lostGeoLon' || propName == 'lostGeoLat'){
                                propMeta.type = String
                            } else {
                                propMeta.type = Number;
                            }
                            break;
                        case 'Date':
                            propMeta.type = Date;
                            break;
                        case 'Boolean':
                            propMeta.type = Boolean;
                            break;
                        default:
                            propMeta.type = String;
                            break;
                    }
                    _animalModelSchemas[modelSchemaName][propName] = new mongoose.Schema({
                        default: propMeta.type,
                        type: String,
                        name: String,
                        key: String,
                        fieldLabel: String,
                        description: String,
                        required: String,
                        example: propMeta.type,
                        note: String,
                        options: [String]
                    });
                });
                console.log('creating model %s', dump(_animalModelSchemas[modelSchemaName]));
                AnimalModelDocs[modelSchemaName] = mongoose.model(util.format('%s-model', modelSchemaName), _animalModelSchemas[modelSchemaName], (mongodb.config.isDevelopment) ? 'pet_models_test' : 'pet_models_production');
                console.log('created model schema %s', dump(AnimalModelDocs[modelSchemaName].schema));
            });
        }

        initAnimalDocs();
        initAnimalModelDocs();
        console.log('Running in %s mode.', (mongodb.config.isDevelopment) ? 'dev' : 'production');

        if (_.isFunction(callback)) callback.apply(_options.context, [mongodb, _options]);
    });
};

/**
 * Builds search object from provided animalProps object. animalProps is an object of fields corresponding to one of the animal schemas
 * @param {Object} animalProps
 * @returns {Object}
 * @private
 */
mongodb._buildQuery = function (animalProps) {
    var searchParams = {
            species: mongodb._getSpeciesFromProps(animalProps)
        },
        propValue;

    if (searchParams['species'])
        _.forEach(animalProps, function (propData, propName, collection) {
            propValue = propData.val || propData; // check if data has been sent as a model structure
            switch (propName) {
                case 'petId':
                case 'hashId':
                case '_id':
                    // only use given id and quit early
                    searchParams = {'_id': propValue};
                    return false;
                case 'species':
                    // ignore because species was already set
                    break;
                default:
                    var prefix = '',
                        suffix = '',
                        regexArgs = '';
                    if (animalProps['matchStartFor'] && _.indexOf(animalProps['matchStartFor'], propName) >= 0) {
                        prefix = '^';
                    }
                    if (animalProps['matchEndFor'] && _.indexOf(animalProps['matchEndFor'], propName) >= 0) {
                        suffix = '$';
                    }
                    if (animalProps['ignoreCaseFor'] && _.indexOf(animalProps['ignoreCaseFor'], propName) >= 0) {
                        regexArgs = 'i';
                    }
                    if (_.has(animalSchemas[searchParams['species']], propName)) {
                        searchParams[propName] = new RegExp(util.format('%s%s%s', prefix, propValue, suffix), regexArgs);
                    }
                    break;
            }
        });
    return searchParams;
};

/**
 *
 * @param func
 * @param [options]
 * @param options.context
 * @private
 */
mongodb._exec = function (func, options) {
    var _options = _.extend({}, options);
    if (!_.isFunction(func)) {
        console.warn('mongodb._exec() - no function passed');
        return;
    }
    mongodb.queue.push({
        callback: func,
        options: _options
    });

    function onConnected() {
        var callback,
            callbackOptions;
        while (mongodb.queue.length > 0) {
            callback = mongodb.queue[0].callback;
            callbackOptions = mongodb.queue[0].options;
            callback.apply(callbackOptions.context, [mongodb, callbackOptions]);
            mongodb.queue.shift();
        }
    }

    if (mongodb.state.isConnected) {
        onConnected();
    } else if (mongodb.state.isConnecting) {
        if (_options.debug) console.log('MongoDB is connecting...');
    } else {
        if (_options.debug) console.log('MongoDB is starting up...');
        mongodb.connect(onConnected);
    }
};

mongodb._sanitizePropsForSearchMatch = function (searchQueryProps) {
    var filteredAnimalQueryProps = {};

    if (searchQueryProps['petName'] || searchQueryProps['petId']) {
        if (searchQueryProps['petId'] && /^\w+$/.test(searchQueryProps['petId'])) {
            filteredAnimalQueryProps['_id'] = searchQueryProps['petId'];
        } else {
            filteredAnimalQueryProps['petName'] = searchQueryProps['petName'];
        }
    } else {
        filteredAnimalQueryProps = searchQueryProps;
    }
    return filteredAnimalQueryProps;
};

mongodb._getSpeciesFromProps = function (animalProps) {

    var _species = (_.isString(animalProps['species'])) ? animalProps['species'].toLowerCase() : defaultSpecies;
    return (animalSchemas[_species]) ? _species : defaultSpecies;
};

mongodb._getSpeciesFromModel = function (animalModelProps) {

    var _species = (_.isString(animalModelProps['species'].default)) ? animalModelProps['species'].default.toLowerCase() : defaultSpecies;
    return (animalModels[_species]) ? _species : defaultSpecies;
};

mongodb._sanitizePropsForSave = function (searchQueryProps) {
    var sanitizedProps = {},
        animalSpecies = mongodb._getSpeciesFromProps(searchQueryProps),
        schema = animalSchemas[animalSpecies];
    if (config.isDevelopment) console.log('using schema for %s', animalSpecies);
    _.forEach(searchQueryProps, function (propValue, propName) {
        if (schema[propName]) {
            switch (schema[propName].type) {
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
    return sanitizedProps;
};

mongodb._sanitizePropsForSend = function (animalProps) {
    var _animalProps = {},
        species = mongodb._getSpeciesFromProps(animalProps),
        model = animalModels[species];
    // format to model structure
    _.forEach(animalProps, function (propVal, propName) {
        _animalProps[propName] = _.extend({
            val: propVal
        }, model[propName]);
    });
    _animalProps['petId'] = {
        val: animalProps['_id']
    };
    return _animalProps;
};

/**
 *
 * @param animalProps
 * @param {Object} options
 * @param {Boolean} [options.debug] Whether to log debug info
 * @param {Function} options.complete callback on operation completion
 * @param {Object} [options.context] context for complete function callback
 */
mongodb.removeAnimal = function (animalProps, options) {
    var _options = _.extend({}, options);

    mongodb._exec(function () {
        if (_options.debug) console.log("mongodb.removeAnimal() - received query for: ", animalProps);

        var searchableProps = mongodb._sanitizePropsForSearchMatch(animalProps),
            animalSpecies = mongodb._getSpeciesFromProps(animalProps);

        if (_options.debug) console.log('mongodb.removeAnimal() - searching for: ', searchableProps);
        AnimalDocs[animalSpecies].remove(searchableProps, function (err) {
            if (_options.debug) console.log('mongodb.removeAnimal() - args: %j', arguments);
            if (_options.complete) _options.complete.apply(null, [{result: err || 'success'}]);
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
mongodb.findAnimal = function (animalProps, options) {
    var _options = _.extend({}, options);

    mongodb._exec(function () {
        if (_options.debug) console.log("mongodb.findAnimal() - received query for: ", animalProps);
        var searchParams = mongodb._buildQuery(animalProps),
            species = mongodb._getSpeciesFromProps(animalProps);

        if (_options.debug) console.log('mongodb.findAnimal() - searching for: ', searchParams);
        AnimalDocs[species].findOne(
            searchParams,
            function (err, _animal) {
                var animal = {};
                if (err) {
                    console.error(err);
                } else {
                    animal = mongodb._sanitizePropsForSend(_animal._doc);
                }
                if (_options.debug) console.log('mongodb.findAnimal() - found animal: ', animal);
                if (_options.complete) _options.complete.apply(null, [err, animal]);
            })
    }, options);
};


/**
 *
 * @param animalProps
 * @param {Object} options
 * @param {Boolean} [options.debug] Whether to log debug info
 * @param {AnimalQueryCallback} options.complete callback on operation completion
 * @param {Object} [options.context] context for complete function callback
 */
mongodb.findAnimals = function (animalProps, options) {
    var _options = _.extend({}, options);
    if (_options.debug) console.log("mongodb.findAnimals(%j)", arguments);

    var query = function () {
        // if (_options.debug) console.log("mongodb.findAnimals() - received query for: ", animalProps);
        var searchParams = mongodb._buildQuery(animalProps),
            species = mongodb._getSpeciesFromProps(animalProps);
        // if (_options.debug) console.log('mongodb.findAnimals() - searching for: ', searchParams);
        AnimalDocs[species].find(
            searchParams,
            function (err, _animals) {
                var animals = [];
                if (err) {
                    console.error(err);
                } else {
                    _.forEach(_animals, function (animal, index) {
                        animals.push(mongodb._sanitizePropsForSend(animal._doc));
                    })
                }
                // if (_options.debug) console.log('mongodb.findAnimals() - found animals: ', animals);
                if (_options.complete) _options.complete.apply(_options.context, [err, animals]);
            })
    };
    mongodb._exec(query, options);
};

/**
 *
 * @param animalProps
 * @param {Object} options
 * @param {Boolean} [options.debug] Whether to log debug info
 * @param {AnimalQueryCallback} options.complete callback on operation completion
 * @param {Object} [options.context] context for complete function callback
 */
mongodb.saveAnimal = function (animalProps, options) {
    var _options = _.extend({}, options);

    mongodb._exec(function () {
        // if (_options.debug) console.log("mongodb.saveAnimal() - received post for: ", animalProps);

        var searchableAnimalProps = mongodb._sanitizePropsForSearchMatch(animalProps),
            savableAnimalProps = mongodb._sanitizePropsForSave(animalProps),
            queryParams = mongodb._buildQuery(searchableAnimalProps),
            animalSpecies = mongodb._getSpeciesFromProps(animalProps);

        // if (_options.debug) console.log('mongodb.saveAnimal() - searching for: ', queryParams);
        AnimalDocs[animalSpecies].findOneAndUpdate(
            queryParams,
            savableAnimalProps, {
                new: true,
                upsert: true
            }, function (err, _animal) {
                var animal = {};
                if (err) {
                    console.error(err);
                } else {
                    animal = mongodb._sanitizePropsForSend(_animal._doc);
                }
                // if (_options.debug) console.log('saved and sending animal: ', animal);
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
 * @param {Boolean} [options.debug] Whether to log debug info
 * @param {AnimalModelQueryCallback} options.complete callback on operation completion
 * @param {Object} [options.context] context for complete function callback
 */
mongodb.findModel = function (animalModelProps, options) {
    var _options = _.extend({}, options);

    mongodb._exec(function () {
        if (_options.debug) console.log("mongodb.findModel() - received request for: ", animalModelProps);

        var animalSpecies = mongodb._getSpeciesFromProps(animalModelProps);

        AnimalModelDocs[animalSpecies].find({}, {}, {
            sort: {_id: -1},
            limit: 1
        }, function (err, animalModel) {
            if (err) {
                console.error(err);
            }
            if (_options.debug) console.log('found and sending animal model: ', animalModel);
            if (_options.complete) _options.complete.apply(_options.context, [null, err || (animalModel[0]) ? animalModel[0] : {}]);
        });
    }, options);
};

/**
 *
 * @param animalModelProps
 * @param {Object} options
 * @param {Boolean} [options.debug] Whether to log debug info
 * @param {AnimalModelQueryCallback} options.complete callback on operation completion
 * @param {Object} [options.context] context for complete function callback
 */
mongodb.saveModel = function (animalModelProps, options) {
    var _options = _.extend({}, options);

    mongodb._exec(function () {
        if (_options.debug) console.log("mongodb.saveAnimalModel() - received model update for w/ %s", dump(animalModelProps));

        var animalSpecies = mongodb._getSpeciesFromModel(animalModelProps);

        if (_options.debug) console.log('mongodb.saveAnimalModel() - searching for %s model', animalSpecies);
        AnimalModelDocs[animalSpecies].create(animalModelProps, function (err, _animalModel) {
            if (err) {
                console.error(err);
            }
            if (_options.debug) console.log('saved and sending animal model: ', _animalModel);
            if (_options.complete) _options.complete.apply(_options.context, [err, _animalModel]);
        });
    }, options);
};

module.exports = mongodb;
