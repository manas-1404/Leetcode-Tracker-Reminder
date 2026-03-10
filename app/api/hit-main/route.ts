import { NextRequest, NextResponse } from 'next/server';
import { sql, getDb } from '@/lib/db';
import {getRedis} from "@/lib/redis";

interface Submission {
  title: string;
  titleSlug: string;
  timestamp: string;
}

async function fetchQuestionFromDB() {
  const result = await sql`
    SELECT id, url
    FROM questions
    WHERE numberofrevision = (
      SELECT MIN(numberofrevision) FROM questions
    )
    ORDER BY RANDOM()
    LIMIT 2;
  `;
  
  return result.rows;
}

async function sendEmail(results: any[]) {
  const serviceId = process.env.EMAILJS_SERVICE_ID;
  const templateId = process.env.EMAILJS_TEMPLATE_ID;
  const userId = process.env.EMAILJS_USER_ID;
  const privateKey = process.env.EMAILJS_PRIVATE_KEY;

  if (results.length < 2) {
    return;
  }

  const [firstQuestion, secondQuestion] = results;

  const templateParams = {
    to_email: process.env.TO_EMAIL,
    subject: "Your Random Questions",
    first_question_id: firstQuestion.id,
    first_question_url: firstQuestion.url,
    second_question_id: secondQuestion.id,
    second_question_url: secondQuestion.url,
  };

  const payload = {
    service_id: serviceId,
    template_id: templateId,
    user_id: userId,
    template_params: templateParams
  };

  const response = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${privateKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Failed to send email: ${response.statusText}`);
  }

  try {
    const redis = getRedis();
    const TTL = 36 * 60 * 60; // 36 hours in seconds

    await Promise.all([
      redis.set('first_question_id', String(firstQuestion.id), { ex: TTL }),
      redis.set('first_question_url', firstQuestion.url, { ex: TTL }),
      redis.set('first_question_solved', 'false', { ex: TTL }),
      redis.set('second_question_id', String(secondQuestion.id), { ex: TTL }),
      redis.set('second_question_url', secondQuestion.url, { ex: TTL }),
      redis.set('second_question_solved', 'false', { ex: TTL })
    ]);
  } catch (e) {
    console.error('[sendEmail] Failed to cache today questions in redis:', e);
  }
}

async function dailyDBUpdate() {
  const url = "https://leetcode.com/graphql";

  const query = `
    query recentAcSubmissions($username: String!, $limit: Int!) {
      recentAcSubmissionList(username: $username, limit: $limit) {
        title
        titleSlug
        timestamp
      }
    }
  `;

  const payload = {
    query,
    variables: {
      username: process.env.LEETCODE_USERNAME,
      limit: 10
    }
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Referer": "https://leetcode.com"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();

  if (data.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
  }

  const submissions: Submission[] = data.data.recentAcSubmissionList;

  // Fetch today's emailed question URLs from Redis so we don't
  // double-count them here — commit-question already handles those.
  const emailedUrls = new Set<string>();
  try {
    const redis = getRedis();
    // @ts-expect-error — @upstash/redis types mget with a tuple overload that
    // doesn't accept a generic string type; the runtime behaviour is correct.
    const [firstUrl, secondUrl] = await redis.mget<string>(
      'first_question_url',
      'second_question_url'
    );
    if (firstUrl) emailedUrls.add(firstUrl);
    if (secondUrl) emailedUrls.add(secondUrl);
  } catch {
    // Redis unavailable — proceed without skipping emailed questions
  }

  // Only count submissions made within the past 24 hours to avoid
  // re-incrementing the same problems on every subsequent cron run.
  const oneDayAgo = Math.floor(Date.now() / 1000) - 24 * 60 * 60;

  // Deduplicate submission URLs (a problem may appear multiple times);
  // keep the first (most-recent) occurrence of each URL.
  const seenUrls = new Set<string>();
  const uniqueSubmissions = submissions.filter((sub) => {
    const fullUrl = `https://leetcode.com/problems/${sub.titleSlug}/`;
    if (seenUrls.has(fullUrl)) return false;
    seenUrls.add(fullUrl);
    return true;
  });

  if (uniqueSubmissions.length === 0) return submissions;

  const allUrls = uniqueSubmissions.map(
    (sub) => `https://leetcode.com/problems/${sub.titleSlug}/`
  );

  // Single batch query to find which of these URLs already exist in the DB.
  const db = getDb();
  const existingResult = await db.query(
    'SELECT url FROM questions WHERE url = ANY($1)',
    [allUrls]
  );
  const existingUrls = new Set<string>(existingResult.rows.map((row: { url: string }) => row.url));

  // Classify each URL into new problems to insert and existing ones to increment.
  const urlsToInsert: string[] = [];
  const urlsToIncrement: string[] = [];

  for (const sub of uniqueSubmissions) {
    const fullUrl = `https://leetcode.com/problems/${sub.titleSlug}/`;
    if (!existingUrls.has(fullUrl)) {
      urlsToInsert.push(fullUrl);
    } else if (!emailedUrls.has(fullUrl) && Number(sub.timestamp) > oneDayAgo) {
      // Already tracked, not one of today's emailed questions, and solved
      // within the past 24 hours — increment its revision count.
      urlsToIncrement.push(fullUrl);
    }
  }

  // Insert new problems one by one (at most 10, and each has a unique URL constraint).
  for (const newUrl of urlsToInsert) {
    await sql`
      INSERT INTO questions (url, numberofrevision, last_sent_date)
      VALUES (${newUrl}, 0, NULL)
    `;
  }

  // Single batched UPDATE for all re-practiced questions.
  if (urlsToIncrement.length > 0) {
    await db.query(
      'UPDATE questions SET numberofrevision = numberofrevision + 1 WHERE url = ANY($1)',
      [urlsToIncrement]
    );
  }

  return submissions;
}

export async function GET(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get('token');
    const expectedToken = process.env.SECRET_TOKEN;

    if (token !== expectedToken) {
      return NextResponse.json(
        { status: "unauthorized", message: "Invalid or missing token" },
        { status: 401 }
      );
    }

    const results = await fetchQuestionFromDB();
    await sendEmail(results);
    await dailyDBUpdate();

    return NextResponse.json({
      status: "success",
      questions: results.map(row => ({ id: row.id, url: row.url }))
    });

  } catch (error) {
    console.error("Error in hit-main:", error);
    return NextResponse.json(
      { status: "error", message: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}