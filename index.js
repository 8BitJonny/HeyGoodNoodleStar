const { App } = require('@slack/bolt')
const store = require('./store')
const messages = require('./messages')
const helpers = require('./helpers')

require('dotenv').config()
const userMentionDetectionRegex = /<@(.*)>/
const containsUserMention = (string) => userMentionDetectionRegex.test(string)
const extractUsersFromString = (string) => [...string.matchAll(userMentionDetectionRegex)].map(e => e[1])
const countNoodlesInMessage = (string) => [...string.matchAll(/(:good-noodle:)/g)].length
const addEmoji = (app, context, message, emoji) => app.client.reactions.add({
  token: context.botToken,
  name: emoji,
  channel: message.channel,
  timestamp: message.ts
});

const app = new App({
  signingSecret: process.env.GOODNOODLE_SLACK_SIGNING_SECRET,
  token: process.env.GOODNOODLE_SLACK_BOT_TOKEN,
  ignoreSelf: true,
  logLevel: 'DEBUG'
});

app.event('app_home_opened', async ({ event, say }) => {
  console.log('1')
  let user = store.getUser(event.user);
  console.log('2')

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
          "text": "*Welcome home, <@" + event.user + "> :house:*"
        }
      }, {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": "Learn how home tabs can be more useful and interactive <https://api.slack.com/surfaces/tabs/using|*in the documentation*>."
        }
      }]
    }
  });
});

app.message(':good-noodle:', async ({ message, context, say }) => {
  console.log(message)

  if (!containsUserMention(message.text)) return;

  const mentionedUsers = extractUsersFromString(message.text);
  const giftedNoodles = countNoodlesInMessage(message.text);
  console.log({ mentionedUsers, giftedNoodles })
  
  const result = await addEmoji(app, context, message, 'thumbsup');
})

app.error(console.error);

// Start your app
(async () => {
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
