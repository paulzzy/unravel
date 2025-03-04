import "server-only";

import { cache } from "react";
import { db } from "@/lib/db";
import { eq, sql, count, desc, and } from "drizzle-orm";
import * as schema from "@/lib/schema";
import { getBlueskyProfile, getUser } from "../user";
import * as atprotoPost from "../atproto/post";
import { DID } from "../atproto/did";

const votesSubQuery = db
  .select({
    postId: schema.PostVote.postId,
    voteCount: sql`coalesce(${count(schema.PostVote.id)}, 1)`
      .mapWith(Number)
      .as("voteCount"),
  })
  .from(schema.PostVote)
  .groupBy(schema.PostVote.postId)
  .as("vote");

const buildUserHasVotedQuery = cache(async () => {
  const user = await getUser();

  return db
    .select({ postId: schema.PostVote.postId })
    .from(schema.PostVote)
    .where(user ? eq(schema.PostVote.authorDid, user.did) : sql`false`)
    .as("hasVoted");
});

const commentCountSubQuery = db
  .select({
    postId: schema.Comment.postId,
    commentCount: count(schema.Comment.id).as("commentCount"),
  })
  .from(schema.Comment)
  .where(eq(schema.Comment.status, "live"))
  .groupBy(schema.Comment.postId, schema.Comment.status)
  .as("commentCount");

export const getFrontpagePosts = cache(async () => {
  // This ranking is very naive. I believe it'll need to consider every row in the table even if you limit the results.
  // We should closely monitor this and consider alternatives if it gets slow over time
  const rank = sql<number>`
  CAST(COALESCE(${votesSubQuery.voteCount}, 1) AS REAL) / (
    pow(
      (JULIANDAY('now') - JULIANDAY(${schema.Post.createdAt})) * 24 + 2,
      1.8
    )
  )
`.as("rank");

  const userHasVoted = await buildUserHasVotedQuery();

  const rows = await db
    .select({
      id: schema.Post.id,
      rkey: schema.Post.rkey,
      cid: schema.Post.cid,
      title: schema.Post.title,
      url: schema.Post.url,
      createdAt: schema.Post.createdAt,
      authorDid: schema.Post.authorDid,
      voteCount: votesSubQuery.voteCount,
      commentCount: commentCountSubQuery.commentCount,
      rank: rank,
      userHasVoted: userHasVoted.postId,
      status: schema.Post.status,
    })
    .from(schema.Post)
    .leftJoin(
      commentCountSubQuery,
      eq(commentCountSubQuery.postId, schema.Post.id),
    )
    .leftJoin(votesSubQuery, eq(votesSubQuery.postId, schema.Post.id))
    .leftJoin(userHasVoted, eq(userHasVoted.postId, schema.Post.id))
    .where(eq(schema.Post.status, "live"))
    .orderBy(desc(rank));

  return rows.map((row) => ({
    id: row.id,
    rkey: row.rkey,
    cid: row.cid,
    title: row.title,
    url: row.url,
    createdAt: row.createdAt,
    authorDid: row.authorDid,
    voteCount: row.voteCount ?? 1,
    commentCount: row.commentCount ?? 0,
    userHasVoted: Boolean(row.userHasVoted),
  }));
});

export const getUserPosts = cache(async (userDid: DID) => {
  const userHasVoted = await buildUserHasVotedQuery();

  const posts = await db
    .select({
      id: schema.Post.id,
      rkey: schema.Post.rkey,
      cid: schema.Post.cid,
      title: schema.Post.title,
      url: schema.Post.url,
      createdAt: schema.Post.createdAt,
      authorDid: schema.Post.authorDid,
      voteCount: votesSubQuery.voteCount,
      commentCount: commentCountSubQuery.commentCount,
      userHasVoted: userHasVoted.postId,
      status: schema.Post.status,
    })
    .from(schema.Post)
    .leftJoin(
      commentCountSubQuery,
      eq(commentCountSubQuery.postId, schema.Post.id),
    )
    .leftJoin(votesSubQuery, eq(votesSubQuery.postId, schema.Post.id))
    .leftJoin(userHasVoted, eq(userHasVoted.postId, schema.Post.id))
    .where(
      and(eq(schema.Post.authorDid, userDid), eq(schema.Post.status, "live")),
    );

  return posts.map((row) => ({
    id: row.id,
    rkey: row.rkey,
    cid: row.cid,
    title: row.title,
    url: row.url,
    createdAt: row.createdAt,
    authorDid: row.authorDid,
    voteCount: row.voteCount ?? 1,
    commentCount: row.commentCount ?? 0,
    userHasVoted: Boolean(row.userHasVoted),
  }));
});

export const getPost = cache(async (authorDid: DID, rkey: string) => {
  const userHasVoted = await buildUserHasVotedQuery();

  const rows = await db
    .select()
    .from(schema.Post)
    .where(
      and(eq(schema.Post.authorDid, authorDid), eq(schema.Post.rkey, rkey)),
    )
    .leftJoin(
      commentCountSubQuery,
      eq(commentCountSubQuery.postId, schema.Post.id),
    )
    .leftJoin(votesSubQuery, eq(votesSubQuery.postId, schema.Post.id))
    .leftJoin(userHasVoted, eq(userHasVoted.postId, schema.Post.id))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    ...row.posts,
    commentCount: row.commentCount?.commentCount ?? 0,
    voteCount: row.vote?.voteCount ?? 1,
    userHasVoted: Boolean(row.hasVoted),
  };
});

export async function uncached_doesPostExist(authorDid: DID, rkey: string) {
  const row = await db
    .select({ id: schema.Post.id })
    .from(schema.Post)
    .where(
      and(eq(schema.Post.authorDid, authorDid), eq(schema.Post.rkey, rkey)),
    )
    .limit(1);

  return Boolean(row[0]);
}

type CreatePostInput = {
  post: atprotoPost.Post;
  authorDid: DID;
  rkey: string;
  cid: string;
  offset: number;
};

export async function unauthed_createPost({
  post,
  rkey,
  authorDid,
  cid,
  offset,
}: CreatePostInput) {
  await db.transaction(async (tx) => {
    await tx.insert(schema.Post).values({
      rkey,
      cid,
      authorDid,
      title: post.title,
      url: post.url,
      createdAt: new Date(post.createdAt),
    });

    await tx.insert(schema.ConsumedOffset).values({ offset });
  });

  if (process.env.DISCORD_WEBHOOK_URL) {
    const bskyProfile = await getBlueskyProfile(authorDid);
    const webhookResponse = await fetch(process.env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        embeds: [
          {
            title: "New post on Frontpage",
            description: post.title,
            url: `https://frontpage.fyi/post/${authorDid}/${rkey}`,
            color: 10181046,
            author: bskyProfile
              ? {
                  name: `@${bskyProfile.handle}`,
                  icon_url: bskyProfile.avatar,
                  url: `https://frontpage.fyi/profile/${bskyProfile.handle}`,
                }
              : undefined,
            fields: [
              {
                name: "Link",
                value: post.url,
              },
            ],
          },
        ],
      }),
    });

    if (!webhookResponse.ok) {
      console.error("Failed to alert of new post", webhookResponse.statusText);
    }
  } else {
    console.error("Can't alert of new post: No DISCORD_WEBHOOK_URL set");
  }
}

type DeletePostInput = {
  rkey: string;
  offset: number;
};

export async function unauthed_deletePost({ rkey, offset }: DeletePostInput) {
  console.log("Deleting post", rkey, offset);
  await db.transaction(async (tx) => {
    console.log("Updating post status to deleted", rkey);
    await tx
      .update(schema.Post)
      .set({ status: "deleted" })
      .where(eq(schema.Post.rkey, rkey));

    console.log("Inserting consumed offset", offset);
    await tx.insert(schema.ConsumedOffset).values({ offset });
    console.log("Done deleting post");
  });
  console.log("Done deleting post transaction");
}
