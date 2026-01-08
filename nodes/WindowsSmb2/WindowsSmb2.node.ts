import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
} from 'n8n-workflow';

import {
	resources,
	operations,
	fileFields,
	directoryFields,
	commonFields,
} from './WindowsSmb2Description';

declare const require: any;
declare const Buffer: any;
const SMB2 = require('@marsaud/smb2');

export class WindowsSmb2 implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Windows SMB2',
		name: 'windowsSmb2',
		icon: { light: 'file:windowssmb2.svg', dark: 'file:windowssmb2.svg' },
		group: ['input', 'output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Access Windows network file shares via SMB2 protocol',
		defaults: {
			name: 'Windows Fileshare',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'windowsSmb2Api',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: resources,
				default: 'file',
			},
			...operations,
			...fileFields,
			...directoryFields,
			...commonFields,
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		let responseData;

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;

				// Get credentials
				const credentials = await this.getCredentials('windowsSmb2Api', i);

				// Helper function to create SMB2 client
				const createSMB2Client = () => {
					const options = this.getNodeParameter('options', i, {}) as any;
					return new SMB2({
						share: credentials.share,
						domain: credentials.domain,
						username: credentials.username,
						password: credentials.password,
						timeout: options.timeout || credentials.timeout || 30000,
					});
				};

				// Helper function to promisify SMB2 operations
				const promisify = (fn: Function, ...args: any[]) => {
					return new Promise((resolve, reject) => {
						fn(...args, (err: any, result: any) => {
							if (err) reject(err);
							else resolve(result);
						});
					});
				};

				// Helper function to normalize Windows paths
				const normalizePath = (path: string) => {
					if (!path) return '';
					return path.replace(/\//g, '\\').replace(/^\\+/, '');
				};

				if (resource === 'connection') {
					if (operation === 'test') {
						const client = createSMB2Client();

						// Test connection by listing root directory
						const files = (await promisify(client.readdir.bind(client), '')) as string[];

						responseData = {
							connectionTest: 'success',
							message: 'SMB2 connection successful',
							rootDirectoryFiles: files.length,
							sampleFiles: files.slice(0, 5),
							timestamp: new Date().toISOString(),
							credentials: {
								share: credentials.share,
								domain: credentials.domain,
								username: credentials.username,
								timeout: credentials.timeout,
							},
						};
					}
				} else if (resource === 'file') {
					const client = createSMB2Client();

					if (operation === 'read') {
						const filePath = normalizePath(this.getNodeParameter('filePath', i) as string);
						const encodingread = this.getNodeParameter('encoding', i, 'utf8') as string;
						//const data = (await promisify(client.readFile.bind(client), filePath)) as any;
						const data = await new Promise<any>((resolve, reject) => {
							client.readFile(filePath, { encoding: encodingread }, (err: any, content: any) => {
								if (err) return reject(err);
								resolve(content);
							});
						});
						const content = (data as string).toString();

						responseData = {
							filePath,
							content,
							size: data.length,
							encoding: encodingread
						};
					} else if (operation === 'write') {
						const filePath = normalizePath(this.getNodeParameter('filePath', i) as string);
						const fileContent = this.getNodeParameter('fileContent', i) as string;
						const encoding = this.getNodeParameter('encoding', i, 'utf8') as string;
						const overwrite = this.getNodeParameter('overwrite', i, 'yes') as string;

						const fileExists = await new Promise<boolean>((resolve) => {
							client.exists(filePath, (err: any, exists: any) => resolve(!!exists));
						});

						if (fileExists && overwrite === 'no') {
							throw new Error(`The file already exists at path: ${filePath}`);
						}

						const buffer = Buffer.from(fileContent, encoding as any);
						await new Promise<void>((resolve, reject) => {
							client.writeFile(filePath, buffer, (err: any) => {
								if (err) return reject(err);
								resolve();
							});
						});


						responseData = {
							filePath,
							size: buffer.length,
							encoding: encoding,
							success: true,
						};
					} else if (operation === 'delete') {
						const filePath = normalizePath(this.getNodeParameter('filePath', i) as string);

						await promisify(client.unlink.bind(client), filePath);

						responseData = {
							filePath,
							deleted: true,
							success: true,
						};
					} else if (operation === 'move') {
						const sourceFilePath = normalizePath(
							this.getNodeParameter('sourceFilePath', i) as string,
						);
						const destinationFilePath = normalizePath(
							this.getNodeParameter('destinationFilePath', i) as string,
						);

						await promisify(client.rename.bind(client), sourceFilePath, destinationFilePath);

						responseData = {
							sourceFilePath,
							destinationFilePath,
							moved: true,
							success: true,
						};
					} else if (operation === 'metadata') {
						const filePath = normalizePath(this.getNodeParameter('filePath', i) as string);

						const [size, exists] = await Promise.all([
							promisify(client.getSize.bind(client), filePath) as Promise<number>,
							promisify(client.exists.bind(client), filePath) as Promise<boolean>,
						]);

						responseData = {
							filePath,
							exists,
							size: exists ? size : 0,
						};
					}
				} else if (resource === 'directory') {
					const client = createSMB2Client();

					if (operation === 'list') {
						const directoryPath = normalizePath(
							this.getNodeParameter('directoryPath', i, '') as string,
						);

						const files = (await promisify(client.readdir.bind(client), directoryPath)) as string[];

						responseData = {
							directoryPath: directoryPath || '/',
							files,
							count: files.length,
						};
					} else if (operation === 'create') {
						const directoryPath = normalizePath(
							this.getNodeParameter('directoryPath', i) as string,
						);

						await promisify(client.mkdir.bind(client), directoryPath);

						responseData = {
							directoryPath,
							created: true,
							success: true,
						};
					} else if (operation === 'delete') {
						const directoryPath = normalizePath(
							this.getNodeParameter('directoryPath', i) as string,
						);

						await promisify(client.rmdir.bind(client), directoryPath);

						responseData = {
							directoryPath,
							deleted: true,
							success: true,
						};
					}
				}

				const executionData = this.helpers.constructExecutionMetaData(
					this.helpers.returnJsonArray(responseData as any),
					{ itemData: { item: i } },
				);

				returnData.push(...executionData);
			} catch (error) {
				if (this.continueOnFail()) {
					const executionErrorData = this.helpers.constructExecutionMetaData(
						this.helpers.returnJsonArray({ error: error.message }),
						{ itemData: { item: i } },
					);
					returnData.push(...executionErrorData);
					continue;
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
