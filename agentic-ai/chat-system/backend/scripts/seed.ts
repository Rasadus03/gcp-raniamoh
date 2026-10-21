import crypto from 'crypto';
import { dbRepo } from '../src/repositories/database.repository';

async function runSeed(): Promise<void> {
  console.log('==========================================================');
  console.log('Seeding Cloud Spanner (chat-db) & Cloud Firestore (chat-system-db)');
  console.log('==========================================================');

  const seedPassphrase =
    process.env.CHAT_SEED_PASSWORD ||
    `Seed_${crypto.randomBytes(16).toString('base64url')}`;

  const users = [
    {
      user_id: 'usr_alice',
      username: 'alice',
      email: 'alice@example.com',
      password: seedPassphrase,
      display_name: 'Alice Rivera (Principal Architect)',
    },
    {
      user_id: 'usr_bob',
      username: 'bob',
      email: 'bob@example.com',
      password: seedPassphrase,
      display_name: 'Bob Chen (Staff SRE)',
    },
    {
      user_id: 'usr_charlie',
      username: 'charlie',
      email: 'charlie@example.com',
      password: seedPassphrase,
      display_name: 'Charlie Patel (Security Engineer)',
    },
    {
      user_id: 'usr_diana',
      username: 'diana',
      email: 'diana@example.com',
      password: seedPassphrase,
      display_name: 'Diana Okafor (Product Lead)',
    },
  ];

  console.log('[1/3] Upserting 4 test users into Cloud Spanner and Cloud Firestore...');
  for (const user of users) {
    const created = await dbRepo.createUser(user);
    console.log(`  ✓ Upserted user: ${created.username} (${created.user_id})`);
  }

  console.log('[2/3] Creating GROUP and 1-on-1 DIRECT channels with interleaved members...');
  const channelsToSeed = [
    {
      channel_id: 'chn_arch_review',
      type: 'GROUP' as const,
      name: 'architecture-review',
      topic: 'Spanner Interleaved Schema & Firestore Native Mode Review',
      is_private: false,
      created_by: 'usr_alice',
      member_user_ids: ['usr_alice', 'usr_bob', 'usr_charlie', 'usr_diana'],
    },
    {
      channel_id: 'chn_sre_loadtest',
      type: 'GROUP' as const,
      name: 'sre-1m-websockets',
      topic: '1M Concurrent WebSocket Connections & Pub/Sub Adaptive Routing',
      is_private: false,
      created_by: 'usr_bob',
      member_user_ids: ['usr_alice', 'usr_bob', 'usr_charlie'],
    },
    {
      channel_id: 'chn_dm_alice_bob',
      type: 'DIRECT' as const,
      name: 'Alice Rivera & Bob Chen',
      topic: '1-on-1 Direct Message',
      is_private: true,
      created_by: 'usr_alice',
      member_user_ids: ['usr_alice', 'usr_bob'],
    },
  ];

  for (const ch of channelsToSeed) {
    const createdCh = await dbRepo.createChannel(ch);
    console.log(`  ✓ Created channel: ${createdCh.name} (${createdCh.channel_id})`);
  }

  console.log('[3/3] Persisting message history across Cloud Spanner & Cloud Firestore...');
  const seedMessages = [
    {
      channel_id: 'chn_arch_review',
      sender_id: 'usr_alice',
      client_message_id: 'seed_msg_001',
      content:
        'Welcome team! Both Cloud Spanner (chat-db) and Cloud Firestore (chat-system-db) are provisioned in cloud-next25-screendemo.',
    },
    {
      channel_id: 'chn_arch_review',
      sender_id: 'usr_bob',
      client_message_id: 'seed_msg_002',
      content:
        'Confirmed! ChannelMembers and Messages are parent-child interleaved under Channels in Cloud Spanner for single-split locality.',
    },
    {
      channel_id: 'chn_arch_review',
      sender_id: 'usr_charlie',
      client_message_id: 'seed_msg_003',
      content:
        'Security checks passed: parameterized SQL queries, HttpOnly/SameSite cookies, Synchronizer CSRF tokens, and strict CSP nonces are active.',
    },
    {
      channel_id: 'chn_arch_review',
      sender_id: 'usr_diana',
      client_message_id: 'seed_msg_004',
      content:
        'Awesome! You can toggle between Cloud Spanner and Cloud Firestore in the top bar to compare read latency in real time.',
    },
    {
      channel_id: 'chn_sre_loadtest',
      sender_id: 'usr_bob',
      client_message_id: 'seed_msg_005',
      content:
        'Pub/Sub topics chat-node-gateway-1 and channel-broadcast-shard-0 are active and routing real-time WebSocket frames.',
    },
    {
      channel_id: 'chn_sre_loadtest',
      sender_id: 'usr_alice',
      client_message_id: 'seed_msg_006',
      content:
        'Adaptive routing is configured: DMs & small groups route via direct node topics, while mega-channels use sharded channel broadcast topics.',
    },
    {
      channel_id: 'chn_dm_alice_bob',
      sender_id: 'usr_alice',
      client_message_id: 'seed_msg_007',
      content:
        'Hey Bob, is the Cloud Run service ready for our end-to-end production test?',
    },
    {
      channel_id: 'chn_dm_alice_bob',
      sender_id: 'usr_bob',
      client_message_id: 'seed_msg_008',
      content:
        'Yes! Both Spanner and Firestore have identical seeded state and idempotency keys (client_message_id) prevent duplicate writes.',
    },
  ];

  for (const m of seedMessages) {
    const saved = await dbRepo.createMessage(m);
    console.log(
      `  ✓ Saved message ${saved.message_id} in ${saved.channel_id} (seq #${saved.sequence_num})`
    );
  }

  const diagnostics = await dbRepo.getDatabaseDiagnostics();
  console.log('==========================================================');
  console.log('Database Diagnostics:', JSON.stringify(diagnostics, null, 2));
  console.log('Seeding Complete!');
  console.log('==========================================================');
  process.exit(0);
}

runSeed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
