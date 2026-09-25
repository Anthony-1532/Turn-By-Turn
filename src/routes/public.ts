/** Unauthenticated reference data: banks, help content, uploaded files, invite landing. */

import express from 'express';
import mongoose from 'mongoose';
import { Group } from '../models';
import { h, param } from '../middleware';
import { err } from '../utils/errors';
import { isObjectId } from '../utils/validators';
import * as squadco from '../services/squadco';
import { normaliseInviteCode } from '../services/groups';
import { gridfsBucket } from './users';
import help from '../content/help.json';

const router = express.Router();

router.get('/banks', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.json({ banks: squadco.banks });
});

router.get('/content/help', (_req, res) => {
  res.json(help);
});

/** Public teaser for the marketing site / invite link landing page (no member data). */
router.get(
  '/invites/:code',
  h(async (req, res) => {
    const code = normaliseInviteCode(param(req, 'code'));
    const g = await Group.findOne({ inviteCode: code }, 'name contributionAmount cycleFrequency memberCount status');
    if (!g || g.status === 'completed') throw err('INVITE_INVALID');
    res.json({
      code,
      group: { name: g.name, contributionAmount: g.contributionAmount, cycleFrequency: g.cycleFrequency, memberCount: g.memberCount, status: g.status },
      appLinks: { android: 'https://play.google.com/store/apps/details?id=app.turnbyturn', ios: 'https://apps.apple.com/app/turnbyturn' },
    });
  }),
);

/** Profile photos (GridFS). Ids are unguessable ObjectIds; avatars are not sensitive. */
router.get(
  '/files/:id',
  h(async (req, res) => {
    const rawId = param(req, 'id');
    if (!isObjectId(rawId)) throw err('NOT_FOUND');
    const bucket = gridfsBucket();
    const id = new mongoose.Types.ObjectId(rawId);
    const [file] = await bucket.find({ _id: id }).toArray();
    if (!file) throw err('NOT_FOUND');
    const contentType = typeof file.metadata?.contentType === 'string' ? file.metadata.contentType : 'application/octet-stream';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    bucket
      .openDownloadStream(id)
      .on('error', () => res.end())
      .pipe(res);
  }),
);

export default router;
