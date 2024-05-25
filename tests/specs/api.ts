import { execaNode } from 'execa';
import { testSuite, expect } from 'manten';
import { createFixture } from 'fs-fixture';
import {
	tsxCjsPath,
	tsxCjsApiPath,
	tsxEsmPath,
	tsxEsmApiPath,
	tsxEsmApiCjsPath,
	type NodeApis,
} from '../utils/tsx.js';
import { createPackageJson, createTsconfig } from '../fixtures.js';

const tsFiles = {
	'file.ts': `
	import { foo } from './foo'
	export const message = foo as string
	`,
	'foo.ts': `
	import { bar } from './bar.js'
	export const foo = \`foo \${bar}\` as string
	`,
	'bar.ts': 'export type A = 1; export { bar } from "pkg"',
	'node_modules/pkg': {
		'package.json': createPackageJson({
			name: 'pkg',
			type: 'module',
			exports: './index.js',
		}),
		'index.js': 'import "node:process"; export const bar = "bar";',
	},
};

export default testSuite(({ describe }, node: NodeApis) => {
	describe('API', ({ describe }) => {
		describe('CommonJS', ({ test }) => {
			test('cli', async () => {
				await using fixture = await createFixture({
					'index.ts': 'import { message } from \'./file\';\n\nconsole.log(message, new Error().stack);',
					...tsFiles,
				});

				const { stdout } = await execaNode(fixture.getPath('index.ts'), {
					nodePath: node.path,
					nodeOptions: ['--require', tsxCjsPath],
				});
				expect(stdout).toContain('foo bar');
				expect(stdout).toContain('index.ts:3:22');
			});

			test('register / unregister', async () => {
				await using fixture = await createFixture({
					'register.cjs': `
					const { register } = require(${JSON.stringify(tsxCjsApiPath)});
					try {
						require('./file');
					} catch {
						console.log('Fails as expected');
					}

					const unregister = register();

					const loaded = require('./file');
					console.log(loaded.message);

					// Remove from cache
					const loadedPath = require.resolve('./file');
					delete require.cache[loadedPath];

					unregister();

					try {
						require('./file');
					} catch {
						console.log('Unregistered');
					}
					`,
					...tsFiles,
				});

				const { stdout } = await execaNode(fixture.getPath('register.cjs'), [], {
					nodePath: node.path,
					nodeOptions: [],
				});

				expect(stdout).toBe('Fails as expected\nfoo bar\nUnregistered');
			});

			describe('tsx.require()', ({ test }) => {
				test('loads', async () => {
					await using fixture = await createFixture({
						'require.cjs': `
						const path = require('node:path');
						const tsx = require(${JSON.stringify(tsxCjsApiPath)});
						try {
							require('./file');
						} catch {
							console.log('Fails as expected');
						}

						const loaded = tsx.require('./file', __filename);
						console.log(loaded.message);

						// Remove from cache
						const loadedPath = tsx.require.resolve('./file', __filename);
						console.log(loadedPath.split(path.sep).pop());
						delete require.cache[loadedPath];

						try {
							require('./file');
						} catch {
							console.log('Unpolluted global require');
						}
						`,
						...tsFiles,
					});

					const { stdout } = await execaNode(fixture.getPath('require.cjs'), [], {
						nodePath: node.path,
						nodeOptions: [],
					});

					expect(stdout).toBe('Fails as expected\nfoo bar\nfile.ts\nUnpolluted global require');
				});

				test('catchable', async () => {
					await using fixture = await createFixture({
						'require.cjs': `
						const tsx = require(${JSON.stringify(tsxCjsApiPath)});
						try { tsx.require('./file', __filename); } catch {}
						`,
						'file.ts': 'if',
					});

					const { all } = await execaNode(fixture.getPath('require.cjs'), [], {
						nodePath: node.path,
						nodeOptions: [],
						all: true,
					});
					expect(all).toBe('');
				});
			});
		});

		describe('module', ({ describe, test }) => {
			test('cli', async () => {
				await using fixture = await createFixture({
					'package.json': createPackageJson({ type: 'module' }),
					'index.ts': 'import { message } from \'./file\';\n\nconsole.log(message, new Error().stack);',
					...tsFiles,
				});

				const { stdout } = await execaNode(fixture.getPath('index.ts'), {
					nodePath: node.path,
					nodeOptions: [node.supports.moduleRegister ? '--import' : '--loader', tsxEsmPath],
				});
				expect(stdout).toContain('foo bar');
				expect(stdout).toContain('index.ts:3:22');
			});

			if (node.supports.moduleRegister) {
				test('module.register', async () => {
					await using fixture = await createFixture({
						'package.json': createPackageJson({ type: 'module' }),
						'module-register.mjs': `
						import { register } from 'node:module';

						await import('./file.ts').catch((error) => {
							console.log('Fails as expected');
						});

						register(${JSON.stringify(tsxEsmPath)}, {
							parentURL: import.meta.url,
							data: true,
						})

						const { message } = await import('./file.ts?nocache')
						console.log(message)
						`,
						...tsFiles,
					});

					const { stdout } = await execaNode(fixture.getPath('module-register.mjs'), [], {
						nodePath: node.path,
						nodeOptions: [],
					});

					expect(stdout).toBe('Fails as expected\nfoo bar');
				});

				describe('register / unregister', ({ test, describe }) => {
					test('register / unregister', async () => {
						await using fixture = await createFixture({
							'package.json': createPackageJson({ type: 'module' }),
							'register.mjs': `
							import { register } from ${JSON.stringify(tsxEsmApiPath)};
							try {
								await import('./file.ts?1');
							} catch {
								console.log('Fails as expected 1');
							}
	
							{
								const unregister = register();

								const { message } = await import('./file?2');
								console.log(message);

								await unregister();
							}

							try {
								await import('./file.ts?3');
							} catch {
								console.log('Fails as expected 2');
							}

							{
								const unregister = register();

								const { message } = await import('./file?4');
								console.log(message);

								await unregister();
							}
							`,
							...tsFiles,
						});

						const { stdout } = await execaNode(fixture.getPath('register.mjs'), [], {
							nodePath: node.path,
							nodeOptions: [],
						});
						expect(stdout).toBe('Fails as expected 1\nfoo bar\nFails as expected 2\nfoo bar');
					});

					test('onImport', async () => {
						await using fixture = await createFixture({
							'package.json': createPackageJson({ type: 'module' }),
							'register.mjs': `
							import { register } from ${JSON.stringify(tsxEsmApiPath)};

							const unregister = register({
								onImport(file) {
									console.log(file.split('/').pop());
								},
							});
	
							await import('./file');
							`,
							...tsFiles,
						});

						const { stdout } = await execaNode(fixture.getPath('register.mjs'), [], {
							nodePath: node.path,
							nodeOptions: [],
						});
						expect(stdout).toBe('file.ts\nfoo.ts\nbar.ts\nindex.js\nnode:process');
					});

					test('namespace & onImport', async () => {
						await using fixture = await createFixture({
							'package.json': createPackageJson({ type: 'module' }),
							'register.mjs': `
							import { setTimeout } from 'node:timers/promises';
							import { register } from ${JSON.stringify(tsxEsmApiPath)};

							const api = register({
								namespace: 'private',
								onImport(file) {
									console.log(file.split('/').pop());
								},
							});

							await api.import('./file', import.meta.url);

							await setTimeout(100)
							`,
							...tsFiles,
						});

						const { stdout } = await execaNode(fixture.getPath('register.mjs'), [], {
							nodePath: node.path,
							nodeOptions: [],
						});
						expect(stdout).toBe('file.ts\nfoo.ts\nbar.ts\nindex.js');
					});

					describe('tsconfig', ({ test }) => {
						test('should ignore detected unresolvable tsconfig', async () => {
							await using fixture = await createFixture({
								'tsconfig.json': createTsconfig({
									extends: 'doesnt-exist',
								}),
								'register.mjs': `
								import { register } from ${JSON.stringify(tsxEsmApiPath)};
								register();
								`,
							});

							await execaNode('register.mjs', [], {
								cwd: fixture.path,
								nodePath: node.path,
								nodeOptions: [],
							});
						});

						test('disable lookup', async () => {
							await using fixture = await createFixture({
								'tsconfig.json': createTsconfig({
									extends: 'doesnt-exist',
								}),
								'register.mjs': `
								import { register } from ${JSON.stringify(tsxEsmApiPath)};
								register({
									tsconfig: false,
								});
								`,
							});

							await execaNode('register.mjs', [], {
								cwd: fixture.path,
								nodePath: node.path,
								nodeOptions: [],
							});
						});

						test('custom path', async () => {
							await using fixture = await createFixture({
								'package.json': createPackageJson({ type: 'module' }),
								'tsconfig.json': createTsconfig({
									extends: 'doesnt-exist',
								}),
								'tsconfig-custom.json': createTsconfig({
									compilerOptions: {
										jsxFactory: 'Array',
										jsxFragmentFactory: 'null',
									},
								}),
								'register.mjs': `
								import { register } from ${JSON.stringify(tsxEsmApiPath)};
								register({
									tsconfig: './tsconfig-custom.json',
								});
								await import('./tsx.tsx');
								`,
								'tsx.tsx': `
								console.log(<>hi</>);
								`,
							});

							const { stdout } = await execaNode('register.mjs', [], {
								cwd: fixture.path,
								nodePath: node.path,
								nodeOptions: [],
							});
							expect(stdout).toBe('[ null, null, \'hi\' ]');
						});

						test('custom path - invalid', async () => {
							await using fixture = await createFixture({
								'package.json': createPackageJson({ type: 'module' }),
								'register.mjs': `
								import { register } from ${JSON.stringify(tsxEsmApiPath)};
								register({
									tsconfig: './doesnt-exist',
								});
								await import('./tsx.tsx');
								`,
								'tsx.tsx': `
								console.log(<>hi</>);
								`,
							});

							const { exitCode, stderr } = await execaNode('register.mjs', [], {
								reject: false,
								cwd: fixture.path,
								nodePath: node.path,
								nodeOptions: [],
							});
							expect(exitCode).toBe(1);
							expect(stderr).toMatch('Cannot resolve tsconfig at path');
						});

						test('fallsback to env var', async () => {
							await using fixture = await createFixture({
								'package.json': createPackageJson({ type: 'module' }),
								'tsconfig.json': createTsconfig({
									extends: 'doesnt-exist',
								}),
								'tsconfig-custom.json': createTsconfig({
									compilerOptions: {
										jsxFactory: 'Array',
										jsxFragmentFactory: 'null',
									},
								}),
								'register.mjs': `
								import { register } from ${JSON.stringify(tsxEsmApiPath)};
								register();
								await import('./tsx.tsx');
								`,
								'tsx.tsx': `
								console.log(<>hi</>);
								`,
							});

							const { stdout } = await execaNode('register.mjs', [], {
								cwd: fixture.path,
								nodePath: node.path,
								nodeOptions: [],
								env: {
									TSX_TSCONFIG_PATH: 'tsconfig-custom.json',
								},
							});
							expect(stdout).toBe('[ null, null, \'hi\' ]');
						});
					});
				});

				describe('tsImport()', ({ test }) => {
					test('module', async () => {
						await using fixture = await createFixture({
							'package.json': createPackageJson({ type: 'module' }),
							'import.mjs': `
							import { tsImport } from ${JSON.stringify(tsxEsmApiPath)};
	
							await import('./file.ts').catch((error) => {
								console.log('Fails as expected 1');
							});
	
							const { message } = await tsImport('./file.ts', import.meta.url);
							console.log(message);
	
							const { message: message2 } = await tsImport('./file.ts?with-query', import.meta.url);
							console.log(message2);
	
							// Global not polluted
							await import('./file.ts?nocache').catch((error) => {
								console.log('Fails as expected 2');
							});
							`,
							...tsFiles,
						});

						const { stdout } = await execaNode(fixture.getPath('import.mjs'), [], {
							nodePath: node.path,
							nodeOptions: [],
						});
						expect(stdout).toBe('Fails as expected 1\nfoo bar\nfoo bar\nFails as expected 2');
					});

					test('commonjs', async () => {
						await using fixture = await createFixture({
							'package.json': createPackageJson({ type: 'module' }),
							'import.cjs': `
							const { tsImport } = require(${JSON.stringify(tsxEsmApiCjsPath)});
	
							(async () => {
								await import('./file.ts').catch((error) => {
									console.log('Fails as expected 1');
								});
		
								const { message } = await tsImport('./file.ts', __filename);
								console.log(message);
		
								const { message: message2 } = await tsImport('./file.ts?with-query', __filename);
								console.log(message2);
		
								// Global not polluted
								await import('./file.ts?nocache').catch((error) => {
									console.log('Fails as expected 2');
								});
							})();
							`,
							...tsFiles,
						});

						const { stdout } = await execaNode(fixture.getPath('import.cjs'), [], {
							nodePath: node.path,
							nodeOptions: [],
						});
						expect(stdout).toBe('Fails as expected 1\nfoo bar\nfoo bar\nFails as expected 2');
					});

					test('mts from commonjs', async () => {
						await using fixture = await createFixture({
							'import.cjs': `
							const { tsImport } = require(${JSON.stringify(tsxEsmApiCjsPath)});

							(async () => {
								const { message } = await tsImport('./file.mts', __filename);
								console.log(message);
							})();
							`,
							'file.mts': 'export const message = "foo bar"',
						});

						const { stdout } = await execaNode(fixture.getPath('import.cjs'), [], {
							nodePath: node.path,
							nodeOptions: [],
						});
						expect(stdout).toBe('foo bar');
					});

					test('namespace allows async nested calls', async () => {
						await using fixture = await createFixture({
							'package.json': createPackageJson({ type: 'module' }),
							'import.mjs': `
							import { tsImport } from ${JSON.stringify(tsxEsmApiPath)};
							tsImport('./file.ts', import.meta.url);
							import('./file.ts').catch(() => console.log('Fails as expected'))
							`,
							'file.ts': 'import(\'./foo.ts\')',
							'foo.ts': 'console.log(\'foo\' as string)',
						});

						const { stdout } = await execaNode(fixture.getPath('import.mjs'), [], {
							nodePath: node.path,
							nodeOptions: [],
						});
						expect(stdout).toBe('Fails as expected\nfoo');
					});

					test('onImport & doesnt cache files', async () => {
						await using fixture = await createFixture({
							'package.json': createPackageJson({ type: 'module' }),
							'import.mjs': `
							import { setTimeout } from 'node:timers/promises';
							import { tsImport } from ${JSON.stringify(tsxEsmApiPath)};
							const dependenciesA = [];
							await tsImport('./file.ts', {
								parentURL: import.meta.url,
								onImport(file) {
									dependenciesA.push(file);
								},
							});

							const dependenciesB = [];
							await tsImport('./file.ts', {
								parentURL: import.meta.url,
								onImport(file) {
									dependenciesB.push(file);
								},
							});

							// wait for async import() to finish
							await setTimeout(100)

							if (JSON.stringify(dependenciesA) !== JSON.stringify(dependenciesB)) {
								console.log({
									dependenciesA,
									dependenciesB,
								});
								process.exitCode = 1
							}
							`,
							'file.ts': 'import "./foo.ts"; import(\'./bar.ts\')',
							'foo.ts': 'console.log(\'foo\' as string)',
							'bar.ts': 'import(\'./foo.ts\')',
						});

						const { stdout } = await execaNode(fixture.getPath('import.mjs'), [], {
							nodePath: node.path,
							nodeOptions: [],
						});
						expect(stdout).toBe('foo\nfoo');
					});

					test('tsconfig disable', async () => {
						await using fixture = await createFixture({
							'package.json': createPackageJson({ type: 'module' }),
							'tsconfig.json': createTsconfig({ extends: 'doesnt-exist' }),
							'import.mjs': `
							import { tsImport } from ${JSON.stringify(tsxEsmApiPath)};

							await tsImport('./file.ts', {
								parentURL: import.meta.url,
								tsconfig: false,
							});
							`,
							...tsFiles,
						});

						await execaNode('import.mjs', [], {
							cwd: fixture.path,
							nodePath: node.path,
							nodeOptions: [],
						});
					});
				});
			} else {
				test('no module.register error', async () => {
					await using fixture = await createFixture({
						'package.json': createPackageJson({ type: 'module' }),
						'register.mjs': `
						import { register } from ${JSON.stringify(tsxEsmApiPath)};

						{
							const unregister = register();

							const { message } = await import('./file?2');
							console.log(message);

							await unregister();
						}
						`,
						...tsFiles,
					});

					const { stderr } = await execaNode(fixture.getPath('register.mjs'), [], {
						nodePath: node.path,
						nodeOptions: [],
						reject: false,
					});
					expect(stderr).toMatch(`This version of Node.js (v${node.version}) does not support module.register(). Please upgrade to Node v18.9 or v20.6 and above.`);
				});
			}
		});
	});
});
