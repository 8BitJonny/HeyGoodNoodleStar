const { App } = require('@slack/bolt')
const Airtable = require('airtable');
const store = require('./store')
const messages = require('./messages')
const helpers = require('./helpers')
const dayjs = require('dayjs')
var weekOfYear = require('dayjs/plugin/weekOfYear')
dayjs.extend(weekOfYear)

require('dotenv').config()

const app = new App({
  signingSecret: process.env.GOODNOODLE_SLACK_SIGNING_SECRET,
  appToken: process.env.GOODNOODLE_SLACK_APP_LEVEL_TOKEN,
  clientId: process.env.GOODNOODLE_CLIENT_ID,
  clientSecret: process.env.GOODNOODLE_CLIENT_SECRET,
  stateSecret: 'my-secret',
  scopes: ['chat:write', 'reactions:write', 'users.profile:read', 'groups:history', 'im:history', 'mpim:history', 'channels:history'],
  socketMode: true,
  ignoreSelf: true,
  logLevel: 'DEBUG',
  customRoutes: [{
    path: '/alive',
    method: ['GET'],
    handler: (req, res) => {
      res.writeHead(200);
      res.end('Health check information displayed here!');
    },
  }],
  installationStore: {
    storeInstallation: async (installation) => {
      if (installation.isEnterpriseInstall && installation.enterprise !== undefined) {
        return await insertInstallation(installation.enterprise.id, JSON.stringify(installation));
      }
      if (installation.team !== undefined) {
        return await insertInstallation(installation.team.id, JSON.stringify(installation));
      }
      throw new Error('Failed saving installation data to installationStore');
    },
    fetchInstallation: async (installQuery) => {
      if (installQuery.isEnterpriseInstall && installQuery.enterpriseId !== undefined) {
        const result = await getInstallation(installQuery.enterpriseId);
        return JSON.parse(result.get('Installation'))
      }
      if (installQuery.teamId !== undefined) {
        const result = await getInstallation(installQuery.teamId);
        return JSON.parse(result.get('Installation'))
      }
      throw new Error('Failed fetching installation');
    },
    deleteInstallation: async (installQuery) => {
      if (installQuery.isEnterpriseInstall && installQuery.enterpriseId !== undefined) {
        return await deleteInstallation(installQuery.enterpriseId);
      }
      if (installQuery.teamId !== undefined) {
        return await deleteInstallation(installQuery.teamId);
      }
      throw new Error('Failed to delete installation');
    },
  },
});

const WEEKLY_TOKEN_AMOUNT = 5

const airtable = new Airtable({ apiKey: process.env.AIRTABLE_KEY }).base('appF6p1Lb1oJR01eN')
const userTable = airtable('Users')
const sendTokensTable = airtable('TokensSend')
const installationTable = airtable('Installation')

const userMentionDetectionRegex = /<@(.*)>/
const containsUserMention = (string) => userMentionDetectionRegex.test(string)
const extractUsersFromString = (string) => [...string.matchAll(/<@(.{11})>/g)].map(e => e[1])
const countNoodlesInMessage = (string) => [...string.matchAll(/(:good-noodle:)/g)].length
const addEmoji = (app, context, message, emoji) => app.client.reactions.add({
  token: context.botToken,
  name: emoji,
  channel: message.channel,
  timestamp: message.ts
});


function insertInstallation(ID, Installation) {
  return installationTable.create([{ fields: { ID, Installation } }])
}
async function getInstallation(ID) {
  return (await installationTable
    .select({ maxRecords: 1, filterByFormula: `{ID} = '${ID}'` })
    .all())[0]
}
async function deleteInstallation(ID) {
  const recordID = (await getInstallation(ID)).id
  return installationTable.destroy([recordID])
}
async function getUser(userID) {
  return (await userTable
    .select({ maxRecords: 1, filterByFormula: `{UserID} = '${userID}'` })
    .all())[0]
}
async function getRemainingWeeklyTokens(userID) {
  const allSendTransactions = await sendTokensTable
    .select({ filterByFormula: `AND({Week} = ${dayjs().week()}, {Year} = ${dayjs().year()}, {SenderID} = '${userID}')` })
    .all()
  const sendTokenAmount = allSendTransactions.reduce((sum, record) => sum + record.get('TokenAmount'), 0)
  return sendTokenAmount >= 0
    ? WEEKLY_TOKEN_AMOUNT - sendTokenAmount
    : 0
}
function fetchName(botToken, userID) {
  return app.client.users.profile.get({ token: botToken, user: userID })
    .then(response => {
      if (!response.ok) {
        Promise.reject(response.error)
      }
      return response.profile.display_name || response.profile.real_name
    })
}
async function upsertUsers(context, userIDs) {
  return Promise.all(userIDs.map(async (userID) => {
    const userExists = await getUser(userID)
    if (userExists) {
      return userExists
    } else {
      const userName = await fetchName(context.botToken, userID)
      return (await insertUser(userID, context.teamId, userName))[0]
    }
  }))
}
function getUsers(context) {
  return userTable.select({ filterByFormula: `{TeamID} = '${context.teamId}'` }).all()
}
function insertUser(UserID, TeamID, FirstName) {
  return userTable.create([{ fields: { UserID, TeamID, FirstName } }])
}
function writeSendNoodlesToDB(transaction) {
  // Transaction length should not exceed 10 per Airtable API
  return sendTokensTable.create(
    transaction.map(({ sender, recipient, tokenAmount: TokenAmount }) => ({
      fields: {
        Week: dayjs().week(),
        Year: dayjs().year(),
        TokenAmount,
        Recipient: [recipient],
        Sender: [sender]
      }
    }))
  )
}

app.event('app_home_opened', async ({ event, context }) => {
  await upsertUsers(context, [event.user]);
  const users = await getUsers(context);
  const user = users.find((u) => u.get('UserID') === event.user)
  const tokensLeft = await getRemainingWeeklyTokens(event.user)

  await app.client.views.publish({
    token: context.botToken,
    user_id: event.user,
    view: {
      "type": "home",
      "blocks": [{
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": "Welcome, <@" + event.user + "> to Mrs. Puff's Boating School! Here, Good Noodle stars are rewarded to good people."
        }
      }, {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": "*How it works*\n\n• Everyone has 5 tacos to give each day.\n\n• To give a taco, send someone a message with their username and a :good-noodle:, like this:\n`@username your positive attitude was a real help today! :good-noodle:`\n\n• Two user mentions and two :good-noodle: means you'll be giving away four good noodles (two per mentioned user)"
        }
      }, {
        "type": "header",
        "text": {
          "type": "plain_text",
          "text": "My Noodles"
        }
      }, {
        "type": "divider"
      }, {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": `Received: ${user.get('TokensReceived')} :good-noodle:\n\nGiven: ${user.get('TokensSend')} :good-noodle:\n\nLeft to Give this week: ${tokensLeft} :good-noodle:`
        }
      }, {
        "type": "header",
        "text": {
          "type": "plain_text",
          "text": "Weekly Noodle Leaderboard"
        }
      }, {
        "type": "divider"
      }, {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": users
            .sort((a, b) => b.get('TokensReceived') - a.get('TokensReceived'))
            .map((u, i) => {
              return `*${i+1}.) <@${u.get('UserID')}>:* ${':good-noodle:'.repeat(u.get('TokensReceived'))} (${u.get('TokensReceived')})`
            })
            .join('\n\n')
        }
      }, {
        "type": "context",
        "elements": [
          {
            "type": "mrkdwn",
            "text": "Need help? It works on my machine but you can try this <https://www.thisworldthesedays.com/help-article.html|help article>"
          }
        ]
      }]
    }
  });
});

app.message(':good-noodle:', async ({ message, context, say }) => {
  if (!containsUserMention(message.text)) return;

  const mentionedUsers = extractUsersFromString(message.text);
  const giftedNoodles = countNoodlesInMessage(message.text);
  console.log({ mentionedUsers, giftedNoodles })

  const [sender, ...recipients] = await upsertUsers(context.botToken, [
    message.user,
    ...mentionedUsers
      .filter(u => u !== message.user)
  ])
    .then(users => users.map(user => user.id))
  
  const totalTokensToBeSend = recipients.length * giftedNoodles
  const tokensLeft = await getRemainingWeeklyTokens(message.user)
  if (tokensLeft - totalTokensToBeSend < 0) {
    await addEmoji(app, context, message, 'eyes');
    return
  }

  await writeSendNoodlesToDB(recipients.map(recipient => ({ sender, recipient, tokenAmount: giftedNoodles })))
  await addEmoji(app, context, message, 'thumbsup');
})

app.error(console.error);

(async () => {
  await app.start(process.env.PORT || 3000);
  const id = await app.client.auth
    .test({ token: process.env.GOODNOODLE_SLACK_BOT_TOKEN })
      .then(result => result.user_id);
  console.log(`Mrs Puff is running! ID: ${id} Port: ${process.env.PORT || 3000}`);
})();
