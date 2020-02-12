#!/usr/bin/env node

/**
 * CLI tool to parse git diff and build a package.xml file from it.
 * This is useful for using the MavensMate deployment tool and selecting the existing package.xml file
 * Also used in larger orgs to avoid deploying all metadata in automated deployments
 *
 * usage:
 *  $ sfpackage master featureBranch ./deploy/
 *
 *  This will create a file at ./deploy/featureBranch/unpackaged/package.xml
 *  and copy each metadata item into a matching folder.
 *  Also if any deletes occurred it will create a file at ./deploy/featureBranch/destructive/destructiveChanges.xml
 */

var program = require('commander');
var util = require('util'),
	spawnSync = require('child_process').spawnSync,
	packageWriter = require('./lib/metaUtils').packageWriter,
	buildPackageDir = require('./lib/metaUtils').buildPackageDir,
	copyFiles = require('./lib/metaUtils').copyFiles,
	packageVersion = require('./package.json').version;
var debugMsgs = false;


program
	.arguments('<compare> <branch> [target]')
	.version(packageVersion)
	.option('-d, --dryrun', 'Only print the package.xml and destructiveChanges.xml that would be generated')
	.option('-p, --pversion [version]', 'Salesforce version of the package.xml', parseInt)
	.option('-x, --destructive', 'Only include destructive (deleted) changes')
	.option('-s, --src <source directory>', 'Root source directory. Defaults to force-app', 'force-app')
	.action(function (compare, branch, target) {

		if (!branch || !compare) {
			console.error('branch and target branch are both required');
			program.help();
			process.exit(1);
		}

		console.log('Running sfpackage');

		var dryrun = false;
		if (program.dryrun) {
			dryrun = true;
		}

		var destructiveOnly = false;
		if (program.destructive) {
			console.log('* Only including destructive changes.');
			destructiveOnly = true;
		}

		if (!dryrun && !target) {
			console.error('target required when not dry-run');
			program.help();
			process.exit(1);
		}

		var currentDir = process.cwd();

		// compare is "existing"
		// branch is new changes I wish to merge
		const gitDiff = spawnSync('git', ['diff', '--name-status', '--no-renames', compare, branch]);
		
		var gitDiffStdOut = gitDiff.stdout.toString('utf8');
		var gitDiffStdErr = gitDiff.stderr.toString('utf8');

		if (gitDiffStdErr) {
			console.error('An error has occurred: %s', gitDiffStdErr);
			process.exit(1);
		}

		var fileListForCopy = [],
			fileList = [];

		//defines the different member types
		var metaBag = {};
		var metaBagDestructive = {};
		var deletesHaveOccurred = false;
		var rootdir = program.src;
		if (debugMsgs) console.log('rootdir: ' + rootdir);

		fileList = gitDiffStdOut.split('\n');
		fileList.forEach(function (fileName, index)
		{
			// get the git operation
			var operation = fileName.slice(0,1);
			// remove the operation and spaces from fileName
			fileName = fileName.slice(1).trim();
			if (debugMsgs) console.log('fileName: ' + fileName);

			//ensure file is inside of src directory of project
			if (fileName && fileName.substring(0, rootdir.length) === rootdir)
			{
				//ignore changes to the package.xml file
				if (fileName === rootdir+'/package.xml')
				{
					return;
				}

				var parts = fileName.split('/');

				// SFDX has some strange folder hierarchies compared to
				// old-school metadata, so we need to tidy these up for this
				// legacy program.
				var removeParts = ["main", "default"];

				var partsLength = parts.length;
				for (var i = 0; i < partsLength; i++)
				{
					if (removeParts.includes(parts[i]))
					{
						if (debugMsgs) console.log('Removing: ' + parts[i]);
						parts.splice(i, 1);
						i--;
					}
				}

				if (debugMsgs) console.log('parts: ' + parts);
				if (debugMsgs) console.log('parts.length: ' + parts.length);

				// Check for invalid fileName, likely due to data stream exceeding buffer size resulting in incomplete string
				// TODO: need a way to ensure that full fileNames are processed - increase buffer size??
				if (parts[2] === undefined) {
					console.error('File name "%s" cannot be processed, exiting', fileName);
					process.exit(1);
				}

				var meta;
				var metaProperty = parts[1];

				if (parts.length === 4)
				{
					// Processing metadata with nested folders e.g. emails, documents, reports
					meta = parts[2] + '/' + parts[3].split('.')[0];
				}
				else if (parts.length === 5 && (parts[3] == 'fields' || parts[3] == 'validationRules'))
				{
					// Processing metadata with nested folders e.g. emails, documents, reports
					meta = parts[2] + '.' + parts[4].split('.')[0];
					metaProperty = parts[3];
				}
				else
				{
					// Processing metadata without nested folders. Strip -meta from the end.
					meta = parts[2].split('.')[0].replace('-meta', '');
				}

				if (debugMsgs) console.log('meta: ' + meta);

				if (operation === 'A' || operation === 'M')
				{
					if (!destructiveOnly)
					{
						// file was added or modified - add fileName to array for unpackaged and to be copied
						console.log('File was added or modified: %s', fileName);
						
						
						// TODO: add flag here to not copy.
						fileListForCopy.push(fileName);

						if (!metaBag.hasOwnProperty(metaProperty)) {
							metaBag[metaProperty] = [];
						}

						if (metaBag[metaProperty].indexOf(meta) === -1) {
							metaBag[metaProperty].push(meta);
						}
					}
				}
				else if (operation === 'D')
				{
					// file was deleted
					console.log('File was deleted: %s', fileName);
					deletesHaveOccurred = true;

					if (!metaBagDestructive.hasOwnProperty(metaProperty)) {
						metaBagDestructive[metaProperty] = [];
					}

					if (metaBagDestructive[metaProperty].indexOf(meta) === -1) {
						metaBagDestructive[metaProperty].push(meta);
					}
				}
				else
				{
					// situation that requires review
					return console.error('Operation on file needs review: %s', fileName);
				}
			}
		});

		//build package file content
		var packageXML = packageWriter(metaBag, program.pversion);

		//build destructiveChanges file content
		var destructiveXML = packageWriter(metaBagDestructive, program.pversion);
		if (dryrun) {
			if (!destructiveOnly)
			{
				console.log('\npackage.xml\n');
				console.log(packageXML);
			}
			console.log('\ndestructiveChanges.xml\n');
			console.log(destructiveXML);
			process.exit(0);
		}

		console.log('Building in directory %s', target);

		// TODO: add flag here to not copy.
		buildPackageDir(target, branch, metaBag, packageXML, false, destructiveOnly, (err, buildDir) => {

			if (err) {
				return console.error(err);
			}

			copyFiles(currentDir, buildDir, fileListForCopy);
			console.log('Successfully created package.xml and files in %s', buildDir);

		});

		if (deletesHaveOccurred) {
			buildPackageDir(target, branch, metaBagDestructive, destructiveXML, true, destructiveOnly, (err, buildDir) => {

				if (err) {
					return console.error(err);
				}

				console.log('Successfully created destructiveChanges.xml in %s',buildDir);
			});
		}
	});

program.parse(process.argv);
