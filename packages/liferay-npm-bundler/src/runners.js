import * as babel from 'babel-core';
import fs from 'fs-extra';
import globby from 'globby';
import * as babelIpc from 'liferay-npm-build-tools-common/lib/babel-ipc';
import * as gl from 'liferay-npm-build-tools-common/lib/globs';
import PluginLogger from 'liferay-npm-build-tools-common/lib/plugin-logger';
import path from 'path';
import readJsonSync from 'read-json-sync';

import * as config from './config';
import * as log from './log';
import report from './report';
import {loadSourceMap} from './util';

/**
 * Run a liferay-npm-bundler plugin
 * @param  {Array} plugins list of plugin descriptors (with name, config and run fields)
 * @param  {PkgDesc} srcPkg source package descriptor
 * @param  {PkgDesc} pkg processed package descriptor
 * @param  {Object} state state to pass to plugins
 * @param  {function} callback a callback function to invoke once per plugin with the used plugin and PluginLogger
 * @return {Object} the state object
 */
export function runPlugins(plugins, srcPkg, pkg, state, callback) {
	plugins.forEach(plugin => {
		const params = {
			config: plugin.config,
			log: new PluginLogger(),
			rootPkgJson: readJsonSync('package.json'),
			globalConfig: config.getGlobalConfig(),

			pkg: pkg.clone(),

			source: {
				pkg: srcPkg.clone(),
			},
		};

		plugin.run(params, state);

		if (callback) {
			callback(plugin, params.log);
		}
	});

	return state;
}

/**
 * Run Babel on a package.
 * @param {PkgDesc} pkg the package descriptor
 * @param {Array} ignore array of output-relative file paths to avoid when processing with Babel
 * @return {Promise} a Promise fulfilled when the process has been finished
 */
export function runBabel(pkg, {ignore = []} = {}) {
	// Make a copy of the package's Babel configuration
	const babelConfig = cloneObject(config.babel.getConfig(pkg));

	// Tune babel config
	babelConfig.babelrc = false;
	babelConfig.only = '**/*';
	if (babelConfig.sourceMaps === undefined) {
		babelConfig.sourceMaps = true;
	}

	// Report a copy of the package's Babel configuration before loading plugins
	report.packageProcessBabelConfig(pkg, cloneObject(babelConfig));

	// Intercept presets and plugins to load them from here
	babelConfig.plugins = config.babel.loadBabelPlugins(
		babelConfig.presets || [],
		babelConfig.plugins || []
	);
	babelConfig.presets = [];

	// Determine files to process
	let globs = [`${pkg.dir}/**/*.js`]
		.concat(gl.negate(gl.prefix(`${pkg.dir}/`, ignore)))
		.concat([`!${pkg.dir}/node_modules/**`]);

	// Run babel through them
	return globby(globs).then(filePaths => {
		const promises = filePaths.map(
			filePath =>
				new Promise(resolve => {
					const logger = new PluginLogger();

					babelIpc.set(filePath, {
						log: logger,
						rootPkgJson: readJsonSync('package.json'),
						globalConfig: config.getGlobalConfig(),
					});

					const packageFilePath = pkg.isRoot
						? filePath.substring(
							path.resolve(config.getOutputDir()).length + 1
						)
						: filePath.substring(
							filePath.indexOf(`${pkg.id}`) + pkg.id.length + 1
						);

					babel.transformFile(
						filePath,
						Object.assign(
							{
								filenameRelative: filePath,
								inputSourceMap: loadSourceMap(filePath),
							},
							babelConfig
						),
						(err, result) => {
							// Generate and/or log results
							if (err) {
								log.error(
									'Babel failed processing',
									`${pkg.id}/${packageFilePath}:`,
									'it will be copied verbatim (see report file for more info)'
								);

								logger.error('babel', err);

								report.warn(
									'Babel failed processing some .js files: ' +
										'check details of Babel transformations for more info.',
									{unique: true}
								);
							} else {
								const fileName = path.basename(filePath);

								fs.writeFileSync(
									filePath,
									`${result.code}\n` +
										`//# sourceMappingURL=${fileName}.map`
								);

								fs.writeFileSync(
									`${filePath}.map`,
									JSON.stringify(result.map)
								);
							}

							// Report result of babel run
							report.packageProcessBabelRun(
								pkg,
								packageFilePath,
								logger
							);

							if (logger.errorsPresent) {
								report.warn(
									'There are errors for some of the ' +
										'Babel plugins: please check details ' +
										'of Babel transformations.',
									{unique: true}
								);
							} else if (logger.warnsPresent) {
								report.warn(
									'There are warnings for some of the ' +
										'Babel plugins: please check details' +
										'of Babel transformations.',
									{unique: true}
								);
							}

							// Get rid of Babel IPC values
							babelIpc.clear(filePath);

							// Resolve promise
							resolve();
						}
					);
				})
		);

		return Promise.all(promises);
	});
}

/**
 * Clone a value object
 * @param  {Object} object the object to clone
 * @return {Object} a clone of the value object
 */
function cloneObject(object) {
	return JSON.parse(JSON.stringify(object));
}
