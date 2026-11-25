"use strict";

class SimsCloud {
  constructor(client) {
    this.client = client;
  }

  static async connect(config) {
    const url = new URL(config.supabaseUrl);
    if (
      url.protocol !== "https:" ||
      !/^sb_publishable_/.test(config.supabasePublishableKey)
    ) {
      throw new Error("Check the HTTPS Supabase URL and publishable key.");
    }

    const { createClient } = await import(
      "https://esm.sh/@supabase/supabase-js@2.89.0"
    );
    return new SimsCloud(createClient(url.href, config.supabasePublishableKey));
  }

  async staffUser() {
    const { data: { session }, error } = await this.client.auth.getSession();
    if (error) throw error;
    if (!session) return null;

    const { data: isStaff, error: roleError } =
      await this.client.rpc("sims_is_staff");

    if (roleError) throw roleError;
    if (!isStaff) {
      await this.signOut();
      throw new Error("This account does not have SIMS staff access.");
    }
    return session.user;
  }

  async signIn(email, password) {
    const { error } = await this.client.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw error;
  }

  async signOut() {
    let timeout;

    try {
      const { error } = await Promise.race([
        this.client.auth.signOut({ scope: "local" }),
        new Promise((_, reject) => {
          timeout = window.setTimeout(
            () => reject(new Error("Sign-out timed out.")),
            6000
          );
        }),
      ]);

      if (error) throw error;
    } catch {
      // Clear this project's saved session if Supabase cannot complete sign-out.
      const projectRef = new URL(window.SIMS_CONFIG.supabaseUrl)
        .hostname.split(".")[0];
      const key = `sb-${projectRef}-auth-token`;

      window.localStorage.removeItem(key);
      window.localStorage.removeItem(`${key}-code-verifier`);
      window.localStorage.removeItem(`${key}-user`);
      window.location.reload();
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async listRecords() {
    const rows = [];
    const pageSize = 100;

    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await this.client
        .from("students")
        .select(
          "id,student_id,name,surname,first_name,middle_name,suffix,course,year_level,contact_number,enrollment_status,version,library_clearances(status,updated_at)"
        )
        .is("deleted_at", null)
        .order("id")
        .range(offset, offset + pageSize - 1);

      if (error) throw error;
      rows.push(...data);
      if (data.length < pageSize) break;
    }

    return rows.map((row) => ({
      id: row.id,
      studentId: row.student_id,
      name: row.name,
      surname: row.surname,
      firstName: row.first_name,
      middleName: row.middle_name,
      suffix: row.suffix,
      course: row.course,
      year: row.year_level,
      contact: row.contact_number,
      status: row.enrollment_status,
      version: row.version,
      clearance: row.library_clearances?.status ?? null,
      clearanceUpdatedAt: row.library_clearances?.updated_at ?? null,
      deletedAt: null,
    }));
  }

  async saveStudent(student, existing) {
    const values = {
      year_level: student.year,
      contact_number: student.contact,
      enrollment_status: student.status,
    };

    if (student.name !== undefined) {
      Object.assign(values, {
        name: student.name,
        surname: student.surname,
        first_name: student.firstName,
        middle_name: student.middleName || null,
        suffix: student.suffix || null,
      });
    }

    if (student.course !== undefined) values.course = student.course;

    if (!existing) {
      const { error } = await this.client.from("students").insert(values);
      if (error) throw error;
      return;
    }

    const { data, error } = await this.client
      .from("students")
      .update(values)
      .eq("id", existing.id)
      .eq("version", existing.version)
      .select("id")
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      throw Object.assign(new Error("Record changed"), {
        code: "SIMS_CONFLICT",
      });
    }
  }

  async removeStudent(student) {
    const { data, error } = await this.client.rpc("sims_soft_delete", {
      p_id: student.id,
      p_version: student.version,
    });

    if (error) throw error;
    if (!data) {
      throw Object.assign(new Error("Record changed"), {
        code: "SIMS_CONFLICT",
      });
    }
  }
}
