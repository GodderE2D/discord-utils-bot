import polka, { NextHandler, Request, Response } from 'polka';
import { verifyKey } from 'discord-interactions';
import { logger } from './util/logger';
import { jsonParser } from './util/jsonParser';
import { prepareAck, prepareHeader, prepareResponse } from './util/respond';
import { djsDocs, fetchDocResult } from './functions/docs';
import { djsGuide } from './functions/guide';
import { mdnSearch } from './functions/mdn';
import { nodeSearch } from './functions/node';
import { API_BASE_DISCORD, DEFAULT_DOCS_BRANCH, PREFIX_BUG, PREFIX_TEAPOT } from './util/constants';
import { findTag, loadTags, reloadTags, searchTag, showTag, Tag } from './functions/tag';
import Collection from '@discordjs/collection';
import fetch from 'node-fetch';
import Doc from 'discord.js-docs';
import { discordDeveloperDocs } from './functions/discorddocs';

const tagCache: Collection<string, Tag> = new Collection();
void loadTags(tagCache);
logger.info(`Tag cache loaded with ${tagCache.size} entries.`);

function verify(req: Request, res: Response, next: NextHandler) {
	const signature = req.headers['x-signature-ed25519'];
	const timestamp = req.headers['x-signature-timestamp'];

	if (!signature || !timestamp) {
		res.writeHead(401);
		return res.end();
	}
	const isValid = verifyKey(req.rawBody, signature as string, timestamp as string, process.env.DISCORD_PUBKEY!);
	if (!isValid) {
		res.statusCode = 401;
		return res.end();
	}
	void next();
}

export function start() {
	polka()
		.use(jsonParser(), verify)
		.post('/interactions', async (req, res) => {
			try {
				const message = req.body;
				if (message.type === 1) {
					prepareAck(res);
					return res.end();
				}
				if (message.type === 2) {
					const options = message.data.options ?? [];
					const name = message.data.name;

					const args = Object.fromEntries(
						options.map(({ name, value }: { name: string; value: any }) => [name, value]),
					);

					if (name === 'docs') {
						const doc = await Doc.fetch(args.source ?? DEFAULT_DOCS_BRANCH, { force: true });

						return (
							await djsDocs(res, doc, args.source ?? DEFAULT_DOCS_BRANCH, args.query, undefined, args.target)
						).end();
					}

					if (name === 'guide') {
						return (await djsGuide(res, args.query, args.results, args.target)).end();
					}

					if (name === 'ddocs') {
						return (await discordDeveloperDocs(res, args.query, args.results, args.target)).end();
					}

					if (name === 'mdn') {
						return (await mdnSearch(res, args.query, args.target)).end();
					}

					if (name === 'node') {
						return (await nodeSearch(res, args.query, args.version, args.target)).end();
					}

					if (name === 'tag') {
						return (await showTag(res, args.query, tagCache, undefined, args.target)).end();
					}

					if (name === 'tagsearch') {
						return (await searchTag(res, args.query, tagCache, args.target)).end();
					}

					if (name === 'tagreload') {
						return (await reloadTags(res, tagCache, args.remote)).end();
					}

					if (name === 'invite') {
						prepareResponse(
							res,
							`Add the discord.js interaction to your server: [(click here)](<https://discord.com/api/oauth2/authorize?client_id=${process
								.env.DISCORD_CLIENT_ID!}&scope=applications.commands>)`,
							true,
						);
						return res.end();
					}

					logger.warn(`Unknown interaction received: ${name as string} guild: ${message.guild_id as string}`);
				}
				if (message.type === 3) {
					const { token } = message;
					const { custom_id: cId, values: selected } = message.data;
					const [op, target, source] = cId.split('|');

					if (op === 'docsearch') {
						const doc = await Doc.fetch(source, { force: true });

						prepareResponse(res, 'Suggestion sent.', false, [], [], 7);
						res.end();

						try {
							const user = message.user?.id ?? message.member.user.id;
							await fetch(`${API_BASE_DISCORD}/webhooks/${process.env.DISCORD_CLIENT_ID!}/${token as string}`, {
								method: 'POST',
								headers: {
									'Content-Type': 'application/json',
								},
								body: JSON.stringify({
									content: fetchDocResult(source, doc, selected[0], user, target),
									allowed_mentions: { users: target.length ? [target] : [] },
								}),
							});
						} catch (err) {
							logger.error(err as Error);
						}
						return;
					}

					if (op === 'tag') {
						prepareResponse(res, 'Suggestion sent', false, [], [], 7);
						res.end();

						try {
							const user = message.user?.id ?? message.member.user.id;
							await fetch(`${API_BASE_DISCORD}/webhooks/${process.env.DISCORD_CLIENT_ID!}/${token as string}`, {
								method: 'POST',
								headers: {
									'Content-Type': 'application/json',
								},
								body: JSON.stringify({
									content: findTag(tagCache, selected[0], user, target),
									allowed_mentions: { users: target.length ? [target] : [] },
								}),
							});
						} catch (err) {
							logger.error(err as Error);
						}
						return;
					}
				}
				if (message.type === 4) {
					prepareHeader(res);
					const name = message.data.name;
					const options = message.data.options ?? [];
					const args = Object.fromEntries(
						options.map(({ name, value }: { name: string; value: any }) => [name, value]),
					);
					const query: string = args.query.trim();
					if (name === 'docs') {
						const results = [];
						const doc = await Doc.fetch(args.source ?? DEFAULT_DOCS_BRANCH, { force: true });

						if (query.length) {
							const element = doc.get(...query.split(/\.|#/));
							if (element) {
								results.push({ name: element.formattedName, value: element.formattedName });
							} else {
								const searchResult = doc.search(query) ?? [];
								for (const r of searchResult) {
									results.push({
										name: r.formattedName,
										value: r.formattedName,
									});
								}
							}
						} else {
							const searchResult = doc.search('Client') ?? [];
							for (const r of searchResult) {
								results.push({
									name: r.formattedName,
									value: r.formattedName,
								});
							}
						}

						res.write(
							JSON.stringify({
								data: {
									choices: results.slice(0, 19),
								},
								type: 8,
							}),
						);
					} else if (name === 'tag') {
						const results: { name: string; value: string }[] = [];

						if (args.query.length) {
							const keywordMatches: { name: string; value: string }[] = [];
							const contentMatches: { name: string; value: string }[] = [];
							const exactKeywords: { name: string; value: string }[] = [];
							for (const [key, tag] of tagCache.entries()) {
								const exactKeyword = tag.keywords.find((s) => s.toLowerCase() === args.query.toLowerCase());
								const includesKeyword = tag.keywords.find((s) => s.toLowerCase().includes(args.query.toLowerCase()));
								const isContentMatch = tag.content.toLowerCase().includes(args.query);
								if (exactKeyword) {
									exactKeywords.push({
										name: `⭐ ${key}`,
										value: key,
									});
								} else if (includesKeyword) {
									keywordMatches.push({
										name: `🏷️ ${key}`,
										value: key,
									});
								} else if (isContentMatch) {
									contentMatches.push({
										name: `📄 ${key}`,
										value: key,
									});
								}
							}
							results.push(...exactKeywords, ...keywordMatches, ...contentMatches);
						} else {
							results.push(
								...tagCache
									.filter((t) => t.hoisted)
									.map((_, key) => {
										return {
											name: `📌 ${key}`,
											value: key,
										};
									}),
							);
						}

						res.write(
							JSON.stringify({
								data: {
									choices: results.slice(0, 19),
								},
								type: 8,
							}),
						);
					}
					res.end();
					return;
				}
				logger.warn(`Received interaction of type ${message.type as string}`);
				prepareResponse(res, `${PREFIX_BUG} This shouldn't be there...`, true);
				res.end();
			} catch (error) {
				logger.error(error as Error);
				prepareResponse(res, `${PREFIX_TEAPOT} Looks like something went wrong here, please try again later!`, true);
			}
		})
		.listen(parseInt(process.env.PORT!, 10));
	logger.info(`Listening for interactions on port ${parseInt(process.env.PORT!, 10)}`);
}

start();
