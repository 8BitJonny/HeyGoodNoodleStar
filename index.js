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
});

const WEEKLY_TOKEN_AMOUNT = 5

const airtable = new Airtable({ apiKey: process.env.AIRTABLE_KEY }).base('appF6p1Lb1oJR01eN')
const userTable = airtable('Users')
const sendTokensTable = airtable('TokensSend')

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
function fetchName(userID) {
  return app.client.users.profile.get({ user: userID })
    .then(response => {
      if (!response.ok) {
        Promise.reject(response.error)
      }
      return response.profile.display_name || response.profile.real_name
    })
}
async function upsertUsers(userIDs) {
  return Promise.all(userIDs.map(async (userID) => {
    const userExists = await getUser(userID)
    if (userExists) {
      return userExists.id
    } else {
      const userName = await fetchName(userID)
      return (await insertUser(userID, userName))[0].id
    }
  }))
}
async function getUsers() {
  return await userTable
    .select()
    .all()
}
function insertUser(userID, firstName) {
  return userTable
    .create([{
      fields: {
        UserID: userID,
        "First Name": firstName,
      }
    }])
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

app.event('app_home_opened', async ({ event, say }) => {
  const users = await getUsers();
  const user = users.find((u) => u.get('UserID') === event.user)
  const tokensLeft = await getRemainingWeeklyTokens(event.user)

  // Call views.publish with the built-in client
  const result = await app.client.views.publish({
    // Use the user ID associated with the event
    user_id: event.user,
    view: {
      "type": "home",
      "blocks": [{
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": "*Welcome, <@" + event.user + "> :house:*"
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
          "text": "Noodle Received Leaderboard"
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
      }]
    }
  });
});

app.message(':good-noodle:', async ({ message, context, say }) => {
  if (!containsUserMention(message.text)) return;

  const mentionedUsers = extractUsersFromString(message.text);
  const giftedNoodles = countNoodlesInMessage(message.text);
  console.log({ mentionedUsers, giftedNoodles })

  const [sender, ...recipients] = await upsertUsers([
    message.user,
    ...mentionedUsers
      .filter(u => u !== message.user)
  ])
  
  const totalTokensToBeSend = recipients.length * giftedNoodles
  const tokensLeft = await getRemainingWeeklyTokens(message.user)
  if (tokensLeft - totalTokensToBeSend < 0) {
    await addEmoji(app, context, message, 'eyes');
    return
  }

  await writeSendNoodlesToDB(recipients.map(recipient => ({ sender, recipient, tokenAmount: giftedNoodles })))
  
  const result = await addEmoji(app, context, message, 'thumbsup');
})

app.error(console.error);

(async () => {
  console.log(process.env.PORT || 3000)
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ Bolt app is running!');

  // after the app is started we are going to retrieve our Bot's user id through
  // the `auth.test` endpoint (https://api.slack.com/methods/auth.test)
  // and store it for future reference
  let id = await app.client.auth.test({ token: process.env.GOODNOODLE_SLACK_BOT_TOKEN })
    .then(result => result.user_id);
  console.log({ id })

  store.setMe(id);
})();
