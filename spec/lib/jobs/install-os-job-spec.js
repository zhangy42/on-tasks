// Copyright 2015, EMC, Inc.
/* jshint node:true */

'use strict';

var uuid = require('node-uuid');

describe('Install OS Job', function () {
    var InstallOsJob;
    var subscribeRequestProfileStub;
    var subscribeRequestPropertiesStub;
    var subscribeHttpResponseStub;
    var waterline;
    var job;
    var catalogData = {
        "data": [
            {
                "devName": "sda",
                "esxiWwid": "naa.6001e679622a10001de0bbf20a49455c",
                "identifier": 1,
                "linuxWwid": "/dev/disk/by-id/scsi-36001e679622a10001de0bbf20a49455c",
                "scsiId": "10:2:0:0",
                "virtualDisk": "/c0/v0"
            },
            {
                "devName": "sdb",
                "esxiWwid": "t10.ATA_____SATADOM2DSL_3ME__20150429AAAA51522041",
                "identifier": 0,
                "linuxWwid": "/dev/disk/by-id/ata-SATADOM-SL_3ME_20150429AAAA51522041",
                "scsiId": "9:0:0:0",
                "virtualDisk": ""
            },
        ],
        "source": "driveId",
    };

    before(function() {
        helper.setupInjector(
            _.flatten([
                helper.require('/lib/jobs/base-job'),
                helper.require('/lib/jobs/install-os')
            ])
        );

        InstallOsJob = helper.injector.get('Job.Os.Install');
        waterline = helper.injector.get('Services.Waterline');
        subscribeRequestProfileStub = sinon.stub(
            InstallOsJob.prototype, '_subscribeRequestProfile');
        subscribeRequestPropertiesStub = sinon.stub(
            InstallOsJob.prototype, '_subscribeRequestProperties');
        subscribeHttpResponseStub = sinon.stub(
            InstallOsJob.prototype, '_subscribeHttpResponse');
        waterline.catalogs = {
            findMostRecent: sinon.stub().resolves()
        };
    });

    beforeEach(function() {
        subscribeRequestProfileStub.reset();
        subscribeRequestPropertiesStub.reset();
        subscribeHttpResponseStub.reset();
        waterline.catalogs.findMostRecent.reset();
        job = new InstallOsJob(
            {
                profile: 'testprofile',
                completionUri: 'esx-ks',
                version: '7.0',
                repo: 'http://127.0.0.1:8080/myrepo/7.0/x86_64/',
                rootPassword: 'rackhd',
                rootSshKey: null,
                users: [
                    {
                        name: 'test',
                        password: 'testPassword',
                        uid: 100,
                        sshKey: ''
                    }
                ],
                dnsServers: null
            },
            {
                target: 'testid'
            },
            uuid.v4());
        job._subscribeActiveTaskExists = sinon.stub().resolves();
    });

    after(function() {
        subscribeRequestProfileStub.restore();
        subscribeRequestPropertiesStub.restore();
        subscribeHttpResponseStub.restore();
    });

    it("should have a nodeId value", function() {
        expect(job.nodeId).to.equal('testid');
    });

    it("should have a profile value", function() {
        expect(job.profile).to.equal('testprofile');
    });

    it("should generate correct password", function() {
        expect(job.options.rootEncryptedPassword).to.match(/^\$6\$*\$*/);
        expect(job.options.users[0].encryptedPassword).to.match(/^\$6\$*\$*/);
    });

    it("should remove empty ssh key", function() {
        expect(job.options).to.not.have.property('rootSshKey');
        expect(job.options.users[0]).to.not.have.property('sshKey');
    });

    it("should convert some option to empty array", function() {
        expect(job.options.dnsServers).to.have.length(0);
    });

    it("should convert the repo to correct format", function() {
        expect(job.options.repo).to.equal('http://127.0.0.1:8080/myrepo/7.0/x86_64');
    });

    it("should set up message subscribers", function(done) {
        var cb;
        job._preHandling = sinon.stub().resolves();
        job._run();
        process.nextTick(function() {
            expect(subscribeRequestProfileStub).to.have.been.called;
            expect(subscribeRequestPropertiesStub).to.have.been.called;
            expect(subscribeHttpResponseStub).to.have.been.called;

            cb = subscribeRequestProfileStub.firstCall.args[0];
            expect(cb).to.be.a.function;
            expect(cb.call(job)).to.equal(job.profile);

            cb = subscribeRequestPropertiesStub.firstCall.args[0];
            expect(cb).to.be.a.function;
            expect(cb.call(job)).to.equal(job.options);

            cb = subscribeHttpResponseStub.firstCall.args[0];
            expect(cb).to.be.a.function;

            done();
        });
    });

    it("should fetch correct ESXi options from external repository", function() {
        var repo = 'http://abc.xyz/repo/test';
        job.options.completionUri = 'esx-ks';
        job.options.repo = repo;

        job._downloadEsxBootCfg = sinon.stub().resolves(
            'bootstate=0\ntitle=Loading ESXi installer\n' +
            'kernel=/tBoot.b00\nkernelopt=runweasel\n' +
            'modules=/b.b00 --- /jumpSTRt.gz --- /useropts.gz\nbuild=\nupdaTEd=0'
        );
        job._getInstallDisk = sinon.stub().resolves();

        return job._preHandling().then(function() {
            expect(job.options.mbootFile).to.equal(repo + '/mboot.c32');
            expect(job.options.tbootFile).to.equal(repo + '/tboot.b00');
            expect(job.options.moduleFiles).to.equal(repo + '/b.b00 --- ' + repo +
                                                     '/jumpstrt.gz --- ' + repo +
                                                     '/useropts.gz');
        });
    });

    it("should get installed disk info for rhel from catalogs", function() {
        waterline.catalogs.findMostRecent.resolves(catalogData);
        job.options.completionUri = 'rhel';

        return job._preHandling().then(function() {
            expect(job.options.installDisk)
                .to.equal('/dev/disk/by-id/ata-SATADOM-SL_3ME_20150429AAAA51522041');
        });
    });

    it("should get installed disk info for esxi from catalogs", function() {
        waterline.catalogs.findMostRecent.resolves(catalogData);
        job.options.completionUri = 'esx-ks';
        job._fetchEsxOptionFromRepo = sinon.stub().resolves();

        return job._preHandling().then(function() {
            expect(job.options.installDisk)
                .to.equal('t10.ATA_____SATADOM2DSL_3ME__20150429AAAA51522041');
        });
    });

    it("should get default disk for esxi when catalog is invalid", function() {
        waterline.catalogs.findMostRecent.rejects(new Error('invalid catalog'));
        job.options.completionUri = 'esx-ks';
        job._fetchEsxOptionFromRepo = sinon.stub().resolves();

        return job._preHandling().then(function() {
            expect(job.options.installDisk).to.equal('firstDisk');
        });
    });

    it("should get default disk for rhel when catalog is empty", function() {
        waterline.catalogs.findMostRecent.resolves();
        job.options.completionUri = 'rhel';
        job._fetchEsxOptionFromRepo = sinon.stub().resolves();

        return job._preHandling().then(function() {
            expect(job.options.installDisk).to.equal('sda');
        });
    });

 });
