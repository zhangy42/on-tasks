// Copyright 2015, EMC, Inc.
/* jshint: node:true */

'use strict';

var di = require('di');
var http = require('http');

module.exports = installOsJobFactory;
di.annotate(installOsJobFactory, new di.Provide('Job.Os.Install'));
    di.annotate(installOsJobFactory,
    new di.Inject(
        'Job.Base',
        'Logger',
        'Assert',
        'Util',
        '_',
        'Services.Encryption',
        'Promise',
        'Services.Waterline'
    )
);

function installOsJobFactory(
    BaseJob,
    Logger,
    assert,
    util,
    _,
    encrypt,
    Promise,
    waterline
) {
    var logger = Logger.initialize(installOsJobFactory);

    /**
     *
     * @param {Object} options
     * @param {Object} context
     * @param {String} taskId
     * @constructor
     */
    function InstallOsJob(options, context, taskId) {
        var self = this;
        InstallOsJob.super_.call(self, logger, options, context, taskId);

        self.nodeId = self.context.target;
        self.profile = self.options.profile;

        _validateOptions.call(self);
        _convertOptions.call(self);
        _encryptPassword.call(self);
    }
    util.inherits(InstallOsJob, BaseJob);

    /**
     * Validate the input options.
     */
    var _validateOptions = function() {
        assert.string(this.context.target);
        assert.string(this.options.completionUri);
        assert.string(this.options.profile);

        // Some of the install task (such as coreos) still hard coded the repo in
        // the profile/kickstart file, So we cannot assert repo&version here
        //
        // TODO: If all install tasks use the same options format,
        // then uncomment following  lines:
        // assert.string(this.options.repo);
        // assert.string(this.options.version);
        // assert.string(this.options.rootPassword);
        // assert.string(this.options.hostname);
        // assert.string(this.options.domain);

        if (this.options.networkDevices) {
            _.forEach(this.options.networkDevices, function(dev) {
                assert.string(dev.device);
                if (dev.ipv4) {
                    assert.string(dev.ipv4.ipAddr);
                    assert.string(dev.ipv4.gateway);
                    assert.string(dev.ipv4.netmask);
                }

                if (dev.ipv6) {
                    assert.string(dev.ipv6.ipAddr);
                    assert.string(dev.ipv6.gateway);
                    assert.string(dev.ipv6.netmask);
                }
            });
        }

        if (this.options.users) {
            _.forEach(this.options.users, function(user) {
                assert.string(user.name);
                assert.string(user.password);
                assert.number(user.uid);
            });
        }
    };

    /**
     * Convert the options
     */
    var _convertOptions = function() {
        this.options.users = this.options.users || [];
        this.options.networkDevices = this.options.networkDevices || [];
        this.options.dnsServers = this.options.dnsServers || [];

        // Both http://xxx/repo and http://xxx/repo/ should be valid and point to same repository,
        // but our code prefer the previous one
        if (this.options.repo) {
            this.options.repo =  this.options.repo.trim();
            if (_.last(this.options.repo) === '/') {
                this.options.repo =  this.options.repo.substring(0, this.options.repo.length-1);
            }
        }
        //kickstart file is happy to process the 'undefined' value, so change its value to
        //undefined if some optional value is false
        if (!this.options.rootSshKey) {
            delete this.options.rootSshKey;
        }
        _.forEach(this.options.users, function(user) {
            if (!user.sshKey) {
                delete user.sshKey;
            }
        });
    };

    /**
     * Encypt the input password.
     */
    var _encryptPassword = function() {
        var hashAlgorithm = 'sha512';

        if (this.options.users) {
            _.forEach(this.options.users, function(user) {
                if (user.password) {
                    //CentOS/RHEL uses the encrypted password;
                    //ESXi uses the plain password.
                    user.plainPassword = user.password; //plain password to ESXi installer
                    user.encryptedPassword = encrypt.createHash(user.password, hashAlgorithm);
                }
            });
        }

        if (this.options.rootPassword) {
            this.options.rootPlainPassword = this.options.rootPassword;
            this.options.rootEncryptedPassword = encrypt.createHash(this.options.rootPassword,
                                                                    hashAlgorithm);
        }
    };

    /**
     * @memberOf InstallOsJob
     */
    InstallOsJob.prototype._run = function() {
        var self = this;
        self._preHandling().then(function () {
            self._subscribeRequestProfile(function() {
                return self.profile;
            });

            self._subscribeRequestProperties(function() {
                return self.options;
            });

            self._subscribeHttpResponse(function(data) {
                assert.object(data);
                if (199 < data.statusCode && data.statusCode < 300) {
                    if(_.contains(data.url, self.options.completionUri)) {
                        self._done();
                    }
                }
            });
        }).catch(function(error) {
            self._done(error);
            logger.error('fail to fetch the esxi options from external repository', {
                error: error,
                repo: self.repo,
                nodeId: self.nodeId,
                context: self.context
            });
        });
    };

    /**
     * Do some pre hanlding before running OS installation job.
     * @return {Promise}
     */
    InstallOsJob.prototype._preHandling = function() {
        var self = this;
        return Promise.resolve()
        .then(function () {
            return self._getInstallDisk();
        })
        .then(function () {
            if (self._isEsx()) {
                assert.string(self.options.repo);
                return self._fetchEsxOptionFromRepo(self.options.repo).then(function(esxOptions) {
                    logger.debug('Esx options from external repo:', esxOptions);
                    _.defaults(self.options, esxOptions);
                });
            }
            else {
                return Promise.resolve();
            }
        });
    };

    /**
     * Return whether it is now runing job for ESXi installation.
     * @return {Boolean} true if it is now for ESXi installation, otherwise false
     */
    InstallOsJob.prototype._isEsx = function() {
        //TODO: it is not a good idea to judge the ESXi by completionUrl.
        //maybe use the properities that defined in task definition? but the properities are not
        //been passed into job.
        var type = this.options.completionUri;
        if (!type) {
            return false;
        }
        return (type === 'esx-ks');
    };

    /**
     * Fetch the ESXi installation options from exteranl repository
     * @param {String} repo - the external repository address.
     * @return {Promise}
     */
    InstallOsJob.prototype._fetchEsxOptionFromRepo = function (repo) {
        var self = this;
        //first try the lower case because the installation has some problem when the repository
        //is in upper case, but anyway we will try the upper case as a retry, in future we (maybe
        //Vmware?) may have solution to fix the upper case problem.
        return self._downloadEsxBootCfg(repo + '/boot.cfg').catch(function() {
            return self._downloadEsxBootCfg(repo + '/BOOT.CFG');
        }).then(function(data) {
            return _extractBootCfgData(data, repo);
        });
    };

    /**
     * Download the boot configuration from external repository
     * @param {String} urlPath - The full URL for ESXi boot config file
     * @return {Promise} The promise that handle the downloading, the promise will be resolved by
     * Object value.
     */
    InstallOsJob.prototype._downloadEsxBootCfg = function (urlPath) {
        var data = '';
        return new Promise(function (resolve, reject) {
            http.get(urlPath, function(resp) {
                if (resp.statusCode < 200 || resp.statusCode > 299) {
                    reject(new Error('Fail to download ' + urlPath +
                                     ', statusCode=' + resp.statusCode.toString()));
                }
                resp.on('data', function(chunk) {
                    data += chunk;
                });
                resp.on('end', function() {
                   resolve(data);
                });
                resp.on('error', function() {
                    reject(new Error('Failed to download file from url ' + urlPath));
                });
            });
        });
    };

    /**
     * Get the wwid of drive where the OS will be installed
     * @return {Promise} The promise that find out the wwid of the desired disk.
     */
    InstallOsJob.prototype._getInstallDisk = function() {
        var self = this;
        return Promise.resolve()
        .then(function() {
            return waterline.catalogs.findMostRecent({
                node: self.nodeId,
                source: "driveId"
            });
        })
        .then(function(catalog) {
            var result;

            if (!catalog || !catalog.hasOwnProperty("data") || catalog.data.length === 0) {
                // No valid mapping table
                return Promise.reject();
            }

            result = self._isEsx() ? catalog.data[0].esxiWwid : catalog.data[0].linuxWwid;

            // Find SATADOM for OS installation
            // The default value is the first item in driveId catalog
            _.forEach(catalog.data, function(drive) {
                if (drive.esxiWwid.indexOf("t10") === 0) {
                    result = self._isEsx() ? drive.esxiWwid : drive.linuxWwid;
                    return false;
                }
            });

            return result;
        })
        .catch(function() {
            return self._isEsx() ? "firstdisk" : "sda";
        })
        .then(function(installDisk) {
            logger.debug('installDisk wwid: ' + installDisk);
            self.options.installDisk = installDisk;
        });
    };

    /**
     * Extract the value from a whole data by key.
     * @param {String} data - The whole data that cotains all key-value pairs
     * @param {String} key - The key for target value including the key-value delimiter
     * @return {String} The extracted value; If key is not exsited, return empty.
     * @example
     * // return "12xyz - pmq"
     * _extractValue("key1=abc def\nkey2=12xyz - pmq\nkey3=pmq,abq", "key2=")
     */
    function _extractValue(data, pattern) {
        var pos = data.indexOf(pattern);
        if (pos >= 0) {
            pos += pattern.length;
            var lineEndPos = data.indexOf('\n', pos);
            if (lineEndPos >= 0) {
                return data.substring(pos, lineEndPos);
            }
        }
        return '';
    }

    /**
     * Extract all key value pairs that required to ESXi installtion
     * @param {String} fileData - The boot.cfg (BOOT.CFG) data that in the ESXi repository
     * @param {String} repo - The exteranl repository for ESXi installation.
     * @return {Object} The object that contains all key-value paris
     */
    function _extractBootCfgData(fileData, repo) {
        var params = [ {
                key: 'tbootFile',
                pattern: 'kernel='
            }, {
                key: 'moduleFiles',
                pattern: 'modules='
            }
        ];

        var result = {};
        _.forEach(params, function(param) {
            var value = _extractValue(fileData, param.pattern);
            value = value.toLowerCase();
            result[param.key] = value.replace(/\//g, repo + '/');
        });

        result.mbootFile = repo + '/mboot.c32';
        return result;
    }

    return InstallOsJob;
}
