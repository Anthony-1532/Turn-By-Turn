'use strict';

/** Unauthenticated reference data: banks, help content, uploaded files, invite landing. */

const express = require('express');
const mongoose = require('mongoose');
const { Group } = require('../models');
const { h } = require('../middleware');
const { err } = require('../utils/errors');
const squadco = require('../services/squadco');
const { normaliseInviteCode } = require('../services/groups');
const help = require('../content/help.json');

const router = express.Router();

router.get('/banks', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.json({ banks: squadco.banks });
});

router.get('/content/help', (_req, res) => res.json(help));

/** Public teaser for the marketing site / invite link landing page (no member data). */
router.get(
  '/invites/:code',
  h(async (req, res) => {
    const g = await Group.findOne({ inviteCode: normaliseInviteCode(req.params.code) }, 'name contributionAmount cycleFrequency memberCount status');
    if (!g || g.status === 'completed') throw err('INVITE_INVALID');
    res.json({
      code: normaliseInviteCode(req.params.code),
      group: { name: g.name, contributionAmount: g.contributionAmount, cycleFrequency: g.cycleFrequency, memberCount: g.memberCount, status: g.status },
      appLinks: { android: 'https://play.google.com/store/apps/details?id=app.turnbyturn', ios: 'https://apps.apple.com/app/turnbyturn' },
    });
  }),
);

/** Profile photos (GridFS). Ids are unguessable ObjectIds; avatars are not sensitive. */
router.get(
  '/files/:id',
  h(async (req, res) => {
    if (!/^[a-f0-9]{24}$/i.test(req.params.id)) throw err('NOT_FOUND');
    const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'uploads' });
    const id = new mongoose.Types.ObjectId(req.params.id);
    const [file] = await bucket.find({ _id: id }).toArray();
    if (!file) throw err('NOT_FOUND');
    res.set('Content-Type', (file.metadata && file.metadata.contentType) || 'application/octet-stream');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    bucket.openDownloadStream(id).on('error', () => res.end()).pipe(res);
  }),
);

module.exports = router;
