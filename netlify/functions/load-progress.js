// netlify/functions/load-progress.js
// Returns all user data including per-exam subscription status

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': process.env.SITE_URL || '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const token = (event.headers.authorization || '').replace('Bearer ', '');
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'No auth token' }) };

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token' }) };

  try {
    const [profileRes, attemptsRes, lessonsRes, flashcardsRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', user.id).single(),
      supabase.from('quiz_attempts')
        .select('exam, topic, mode, score, total, pct, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(100),
      supabase.from('lesson_progress')
        .select('exam, lo_id, section_id, completed_at')
        .eq('user_id', user.id),
      supabase.from('flashcard_ratings')
        .select('card_idx, rating, next_review')
        .eq('user_id', user.id),
    ]);

    // Build topic performance summary
    const topicPerf = {};
    if (attemptsRes.data) {
      attemptsRes.data.forEach(a => {
        const key = `${a.exam}:${a.topic}`;
        if (!topicPerf[key]) topicPerf[key] = { attempts: 0, totalPct: 0, bestPct: 0, lastAttempt: null };
        topicPerf[key].attempts++;
        topicPerf[key].totalPct += a.pct;
        if (a.pct > topicPerf[key].bestPct) topicPerf[key].bestPct = a.pct;
        if (!topicPerf[key].lastAttempt || a.created_at > topicPerf[key].lastAttempt) topicPerf[key].lastAttempt = a.created_at;
      });
      Object.keys(topicPerf).forEach(k => {
        topicPerf[k].avgPct = Math.round(topicPerf[k].totalPct / topicPerf[k].attempts);
      });
    }

    const now = new Date().toISOString();
    const dueCards = (flashcardsRes.data || []).filter(c => !c.next_review || c.next_review <= now);
    const recentActivity = (attemptsRes.data || []).slice(0, 5);
    const allAttempts = attemptsRes.data || [];
    const totalQsDone = allAttempts.reduce((sum, a) => sum + a.total, 0);
    const avgScore = allAttempts.length > 0
      ? Math.round(allAttempts.reduce((sum, a) => sum + a.pct, 0) / allAttempts.length)
      : 0;
    const completedSections = new Set((lessonsRes.data || []).map(l => `${l.exam}:${l.lo_id}:${l.section_id}`));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        profile: profileRes.data,
        topicPerformance: topicPerf,
        completedSections: [...completedSections],
        flashcardsDueCount: dueCards.length,
        recentActivity,
        stats: { totalQsDone, avgScore, totalAttempts: allAttempts.length },
      }),
    };
  } catch (err) {
    console.error('load-progress error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
