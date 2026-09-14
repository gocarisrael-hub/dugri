// Agent B (Catalog & Design): the private-design access codes kept on the store,
// moved out of server/db.js (slice 2 of splitting the monolith; see
// docs/agent-partition.md). A VERBATIM move of that block of the `db` object.
//
// The block was never contiguous: createDesignCode sits before the stock block
// (Agent A) and the rest after it. So there are TWO factories, and db.js spreads
// each back at its own position, which keeps the `db` key order unchanged.
// Every caller keeps calling db.createDesignCode(...) etc., `this` is still `db`,
// and there is still ONE in-memory store written by ONE saveDb. Nothing is
// required at the top level, for the same reason as server/stores/platform.js.

function designCodesCreate({ _db, saveDb, normCode, uid, nowIso }) {
  return {
    // --- Private-design access codes ----------------------------------------
    createDesignCode({ code, design_id, valid_until } = {}) {
      const c = normCode(code);
      if (!/^[A-Z0-9]{3,20}$/.test(c)) return { error: 'bad code' };
      const design = String(design_id == null ? '' : design_id)
        .trim()
        .slice(0, 80);
      if (!design) return { error: 'bad design_id' };
      let until = null;
      if (valid_until != null && valid_until !== '') {
        const s = String(valid_until).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
          return { error: 'bad valid_until' };
        }
        until = s;
      }
      if (_db.design_codes.some((x) => x.code === c)) return { error: 'duplicate' };
      const rec = {
        id: uid(),
        code: c,
        design_id: design,
        valid_until: until,
        active: true,
        created_at: nowIso(),
        uses: 0,
      };
      _db.design_codes.push(rec);
      saveDb();
      return rec;
    },
  };
}

function designCodesManage({ _db, saveDb, normCode, todayStrIsrael }) {
  return {
    listDesignCodes() {
      return [..._db.design_codes].sort((a, b) => b.created_at.localeCompare(a.created_at));
    },

    getDesignCodeByCode(code) {
      const c = normCode(code);
      return _db.design_codes.find((x) => x.code === c) || null;
    },

    getDesignCodeById(id) {
      return _db.design_codes.find((x) => x.id === id) || null;
    },

    setDesignCodeActive(id, active) {
      const c = this.getDesignCodeById(id);
      if (!c) return null;
      c.active = !!active;
      saveDb();
      return c;
    },

    deleteDesignCode(id) {
      const before = _db.design_codes.length;
      _db.design_codes = _db.design_codes.filter((x) => x.id !== id);
      if (_db.design_codes.length === before) return false;
      saveDb();
      return true;
    },

    validateDesignCode(code) {
      const c = this.getDesignCodeByCode(code);
      if (!c) return { valid: false, reason: 'not_found' };
      if (!c.active) return { valid: false, reason: 'inactive' };
      if (c.valid_until && todayStrIsrael() > c.valid_until) {
        return { valid: false, reason: 'expired' };
      }
      return { valid: true, design_id: c.design_id };
    },

    incrementDesignCodeUses(code) {
      const c = this.getDesignCodeByCode(code);
      if (!c) return false;
      c.uses = (c.uses || 0) + 1;
      saveDb();
      return true;
    },
  };
}

module.exports = { designCodesCreate, designCodesManage };
