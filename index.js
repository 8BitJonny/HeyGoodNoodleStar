const { App } = require('@slack/bolt')
const store = require('./store')
const messages = require('./messages')
const helpers = require('./helpers')

console.log(process.env.GOODNOODLE_SLACK_BOT_TOKEN)
console.log(process.env.GOODNOODLE_SLACK_SIGNING_SECRET)

const app = new App({
  signingSecret: process.env.GOODNOODLE_SLACK_SIGNING_SECRET,
  token: process.env.GOODNOODLE_SLACK_BOT_TOKEN,
  // setting `ignoreSelf` to `false` to also retrieve events from our Bot user
  // e.g. we want to know when our Bot users is added to a channel through the
  // `member_joined_channel` event
  ignoreSelf: false,
  logLevel: 'DEBUG'
});

/**

`app_home_opened` event is triggered when a user has entered into the App Home space (= Bot User DM)

https://api.slack.com/events/app_home_opened

We use this event to show the user an interactive welcome message once they open a DM with our App
to let them configure our App and let them choose a default channel to post messages to

**/
app.event('app_home_opened', async ({ event, say }) => {
  let user = store.getUser(event.user);

  if (!user) {
    user = {
      user: event.user,
      channel: event.channel
    };
    store.addUser(user);

    await say(messages.welcome_app_home);
  }
});

/**

`reaction_added` event is triggered when a user adds a reaction to a message in a channel where the Bot User is part of

https://api.slack.com/events/reaction_added

We use this event to check if the added emoji (reactji) is a ⚡ (:zap:) emoji. If that's the case,
a link to this message will be posted to the configured channel

**/
app.event('reaction_added', async ({ event, client }) => {
  // only react to ⚡ (:zap:) emoji
  if (event.reaction === 'zap') {
    let channelId = event.item.channel;
    let ts = event.item.ts;

    // get a permalink for this message
    const permalink = await client.chat.getPermalink({
      message_ts: ts,
      channel: channelId,
    });

    // get user info of user who reacted to this message
    const user = await client.users.info({
      user: event.user
    });

    // formatting the user's name to mention that user in the message (see: https://api.slack.com/messaging/composing/formatting)
    let name = '<@' + user.user.id + '>';
    let channel = store.getChannel();

    // post this message to the configured channel
    await client.chat.postMessage({
      channel: channel && channel.id,
      text: name + ' wants you to see this message: ' + permalink.permalink,
      unfurl_links: true,
      unfurl_media: true
    });
  }
})

/**

`member_joined_channel` event is triggered when a user joins public or private channels

https://api.slack.com/events/member_joined_channel

We use this event to introduce our App once it's added to a channel

**/
app.event('member_joined_channel', async ({ event, say }) => {
  let channel = store.getChannel();
  let user = event.user;

  // check if our Bot user itself is joining the channel
  if (user === store.getMe() && channel) {
    let message = helpers.copy(messages.welcome_channel);
    // fill in placeholder values with channel info
    message.blocks[0].text.text = message.blocks[0].text.text
      .replace('{{channelName}}', channel.name)
      .replace('{{channelId}}', channel.id);
    await say(message);
  }
});

/**

The action_id `configure_channel` is triggered when a user interacts with the welcome_app_home message (in messages.js) 

**/
app.action({ action_id: 'configure_channel' }, async ({ action, ack, respond, client }) => {
  await ack();

  let channelId = action.selected_channel;

  // retrieve channel info
  let channelInfo = await client.channels.info({
    channel: channelId
  });

  // save the configured channel to our store
  store.setChannel({
    name: channelInfo.channel.name,
    id: channelId
  });

  let message = helpers.copy(messages.channel_configured);
  // fill in placeholder values with channel info
  message.blocks[0].text.text = message.blocks[0].text.text
    .replace('{{channelId}}', channelId)
    .replace('{{channelName}}', channelInfo.channel.name);
  await respond(message);
});

/**

The action_id `add_to_channel` is triggered when a user interacts with the channel_configured message (in messages.js) 

**/
app.action('add_to_channel', async ({ action, ack, say, client }) => {
  await ack();

  let channelId = action.selected_channel;

  // retrieve channel info
  let channelInfo = await client.conversations.info({
    channel: channelId
  });

  // invite Bot user to channel
  await client.channels.invite({
    channel: channelId,
    user: store.getMe()
  });

  let message = helpers.copy(messages.added_to_channel);
  // fill in placeholder values with channel info
  message.blocks[0].text.text = message.blocks[0].text.text
    .replace('{{channelId}}', channelId)
    .replace('{{channelName}}', channelInfo.channel.name);
  await say(message);
});

app.error(async (error) => {
  // Check the details of the error to handle cases where you should retry sending a message or stop the app
  console.error(error)
});

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