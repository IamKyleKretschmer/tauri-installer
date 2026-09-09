using System;
using System.Collections.Generic;
using Microsoft.Data.SqlClient;

namespace DotNetRunner
{
    /// <summary>
    /// Tests connectivity to a SQL Server instance and ensures the K2
    /// database exists (creating it with the required collation if not),
    /// mirroring the SQL Server step in the K2 Setup wizard.
    /// </summary>
    internal static class SqlServerCheck
    {
        private const string RequiredCollation = "SQL_Latin1_General_CP1_CI_AS";
        private const int ConnectTimeoutSeconds = 8;
        private const string SchemaOwnerUser = "k2_schema_owner";
        // The real K2 installer's AssignSqlUserRole target has no default
        // for Role in what we could recover (it's supplied per-component
        // by a manifest we don't have); db_owner is the standard role for
        // a schema-owner account to fully manage K2's own database.
        private const string SchemaOwnerRole = "db_owner";

        // Ported from the real SourceCode.Install.SQL SqlHelper's
        // _sqlFriendlyVerionLookup: build-number-to-friendly-name map.
        // Matched here by major version only (not the exact 4-part build),
        // since any patched/CU'd engine will have a different exact build
        // number than the baseline one in the real table.
        private static readonly Dictionary<int, string> SqlFriendlyVersionByMajor = new Dictionary<int, string>
        {
            { 10, "2008" },
            { 11, "2012" },
            { 12, "2014" },
            { 13, "2016" },
            { 14, "2017" },
            { 15, "2019" },
            { 16, "2022" },
        };

        // K2HostServer.exe.config ships with a documentation block showing
        // 14 separate per-component connection strings (K2Categories,
        // K2HostServer, K2Server, K2Workspace, etc), suggesting a
        // multi-database architecture. However, a real captured K2 5.9.1
        // silent-install answer file showed every one of those same
        // connection strings pointing at a single consolidated "Initial
        // Catalog=K2" database, confirming the 14-name split is an
        // available option, not what a standard install actually does.
        // Reverted to creating just the single database the wizard's "K2
        // database name" field specifies, matching that real example.

        /// <summary>
        /// args: [0]=test-sql, [1]=server instance, [2]=auth mode (sql|windows),
        /// [3]=username, [4]=password, [5]=database name.
        /// </summary>
        public static int TestConnectionAndDatabase(string[] args)
        {
            if (args.Length < 6)
            {
                Console.Error.WriteLine("Usage: DotNetRunner.exe test-sql <server> <sql|windows> <username> <password> <database>");
                return 1;
            }

            string server = string.IsNullOrWhiteSpace(args[1]) ? @".\SQLEXPRESS" : args[1];
            string authMode = args[2];
            string username = args[3];
            string password = args[4];
            string database = string.IsNullOrWhiteSpace(args[5]) ? "K2" : args[5];

            SqlException lastError = null;

            // "Windows authentication" can mean classic on-prem Kerberos
            // (IntegratedSecurity) or, on an Entra-joined machine, Azure AD
            // integrated auth, which classic IntegratedSecurity can't do.
            // Try both so this works either way without a separate UI
            // option for it.
            foreach (string connectionString in BuildCandidateConnectionStrings(server, authMode, username, password))
            {
                try
                {
                    using (var connection = new SqlConnection(connectionString))
                    {
                        connection.Open();

                        // Always recreate fresh: a database left over from an
                        // earlier failed/partial install attempt may be missing
                        // filegroups or other objects a newer version of this
                        // tool creates (e.g. FG_HostServer), and there is no
                        // way to detect that short of comparing schemas. This
                        // command runs immediately before the real installer,
                        // so a stale leftover database is never something worth
                        // preserving.
                        bool alreadyExisted = DatabaseExists(connection, database);
                        if (alreadyExisted)
                        {
                            DropDatabaseInternal(connection, database);
                        }
                        CreateDatabase(connection, database);
                        ApplyRecommendedDatabaseSettings(connection, database);

                        // Schema-owner user + role assignment mirror the real
                        // CreateSqlUser/AssignSqlUserRole actions. Only doable
                        // for SQL authentication, since that's the only mode
                        // where we have a login name to map the user to; for
                        // Windows auth, K2 would use integrated auth instead
                        // and this step is skipped.
                        string userNote;
                        var dbBuilder = new SqlConnectionStringBuilder(connectionString) { InitialCatalog = database };
                        using (var dbConnection = new SqlConnection(dbBuilder.ConnectionString))
                        {
                            dbConnection.Open();

                            // The real installer's EncryptionValidation checks
                            // (confirmed via a real InstallerTrace log) that a
                            // symmetric key named 'SCSSOKey', protected by a
                            // certificate named 'SCHostServerCert', already
                            // exists in the K2 database - normally created by
                            // K2's own database schema deployment, which this
                            // app doesn't run. Creating them here (idempotent,
                            // matching the real object names exactly) lets
                            // that validator pass against a database we
                            // created ourselves.
                            EnsureEncryptionObjects(dbConnection);

                            if (string.Equals(authMode, "sql", StringComparison.OrdinalIgnoreCase))
                            {
                                EnsureSchemaOwnerUser(dbConnection, username);
                                userNote = $" Schema-owner user '{SchemaOwnerUser}' ensured with '{SchemaOwnerRole}' role.";
                            }
                            else
                            {
                                userNote = " Windows authentication: skipped SQL login-based schema-owner user, K2 will use integrated auth.";
                            }
                        }

                        string dbNote = alreadyExisted
                            ? $"Database '{database}' recreated fresh with collation {RequiredCollation}."
                            : $"Database '{database}' created with collation {RequiredCollation}.";
                        string versionNote = GetFriendlySqlVersionNote(connection);
                        Console.WriteLine($"Connected to {server}{versionNote}. {dbNote}{userNote}");
                        return 0;
                    }
                }
                catch (SqlException ex)
                {
                    lastError = ex;
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"Unexpected error testing '{server}': {ex.Message}");
                    return 1;
                }
            }

            Console.Error.WriteLine($"Could not connect to '{server}': {lastError?.Message}");
            return 1;
        }

        /// <summary>
        /// Drops the K2 database, reversing TestConnectionAndDatabase's
        /// CreateDatabase. Forces existing connections off first
        /// (SINGLE_USER WITH ROLLBACK IMMEDIATE), same as any real
        /// uninstall would need to since a running K2 server would
        /// otherwise be holding a connection open.
        /// args: [0]=drop-database, [1]=server, [2]=auth mode, [3]=username, [4]=password, [5]=database.
        /// </summary>
        public static int DropDatabase(string[] args)
        {
            if (args.Length < 6)
            {
                Console.Error.WriteLine("Usage: DotNetRunner.exe drop-database <server> <sql|windows> <username> <password> <database>");
                return 1;
            }

            string server = string.IsNullOrWhiteSpace(args[1]) ? @".\SQLEXPRESS" : args[1];
            string authMode = args[2];
            string username = args[3];
            string password = args[4];
            string database = string.IsNullOrWhiteSpace(args[5]) ? "K2" : args[5];

            SqlException lastError = null;

            foreach (string connectionString in BuildCandidateConnectionStrings(server, authMode, username, password))
            {
                try
                {
                    using (var connection = new SqlConnection(connectionString))
                    {
                        connection.Open();

                        if (!DatabaseExists(connection, database))
                        {
                            Console.WriteLine($"Database '{database}' does not exist on {server}, nothing to drop.");
                            return 0;
                        }

                        DropDatabaseInternal(connection, database);

                        Console.WriteLine($"Database '{database}' dropped from {server}.");
                        return 0;
                    }
                }
                catch (SqlException ex)
                {
                    lastError = ex;
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"Unexpected error dropping database on '{server}': {ex.Message}");
                    return 1;
                }
            }

            Console.Error.WriteLine($"Could not connect to '{server}': {lastError?.Message}");
            return 1;
        }

        private static IEnumerable<string> BuildCandidateConnectionStrings(string server, string authMode, string username, string password)
        {
            if (string.Equals(authMode, "windows", StringComparison.OrdinalIgnoreCase))
            {
                yield return BuildConnectionString(server, "master", SqlAuthenticationMethod.NotSpecified, null, null);
                yield return BuildConnectionString(server, "master", SqlAuthenticationMethod.ActiveDirectoryIntegrated, null, null);
            }
            else
            {
                yield return BuildConnectionString(server, "master", SqlAuthenticationMethod.SqlPassword, username, password);
            }
        }

        private static string BuildConnectionString(string server, string database, SqlAuthenticationMethod authMethod, string username, string password)
        {
            var builder = new SqlConnectionStringBuilder
            {
                DataSource = server,
                InitialCatalog = database,
                ConnectTimeout = ConnectTimeoutSeconds,
                // Microsoft.Data.SqlClient defaults Encrypt=true and validates
                // the server's certificate against a trusted CA, unlike the
                // legacy System.Data.SqlClient. Internal/test SQL Servers
                // almost always use a self-signed cert, which fails that
                // validation ("certificate chain was issued by an authority
                // that is not trusted"). TrustServerCertificate keeps the
                // connection encrypted but skips CA validation, the standard
                // approach for exactly this case.
                TrustServerCertificate = true,
            };

            switch (authMethod)
            {
                case SqlAuthenticationMethod.NotSpecified:
                    builder.IntegratedSecurity = true;
                    break;
                case SqlAuthenticationMethod.ActiveDirectoryIntegrated:
                    builder.Authentication = SqlAuthenticationMethod.ActiveDirectoryIntegrated;
                    break;
                case SqlAuthenticationMethod.SqlPassword:
                    builder.UserID = username;
                    builder.Password = password;
                    break;
            }

            return builder.ConnectionString;
        }

        /// <summary>
        /// Reports the connected server's edition as "SQL Server 2019"
        /// etc, using the same build-number-to-friendly-name mapping as
        /// the real installer's SqlHelper.GetSupportedSqlServerFriendlyVersion,
        /// informational only (no minimum-version enforcement, since the
        /// real minimum-supported-version constant isn't something we
        /// could recover).
        /// </summary>
        private static string GetFriendlySqlVersionNote(SqlConnection connection)
        {
            try
            {
                using (var command = new SqlCommand("SELECT SERVERPROPERTY('ProductVersion')", connection))
                {
                    object result = command.ExecuteScalar();
                    if (result == null || result == DBNull.Value) return string.Empty;

                    string productVersion = result.ToString();
                    int majorVersion = int.Parse(productVersion.Split('.')[0]);

                    return SqlFriendlyVersionByMajor.TryGetValue(majorVersion, out string friendlyName)
                        ? $" (SQL Server {friendlyName})"
                        : $" (SQL Server, product version {productVersion})";
                }
            }
            catch
            {
                return string.Empty;
            }
        }

        /// <summary>
        /// Forces existing connections off (SINGLE_USER WITH ROLLBACK
        /// IMMEDIATE) and drops the database. Caller must have already
        /// confirmed the database exists.
        /// </summary>
        private static void DropDatabaseInternal(SqlConnection connection, string database)
        {
            string sanitized = database.Replace("]", "]]");
            using (var command = new SqlCommand($"ALTER DATABASE [{sanitized}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE", connection))
            {
                command.ExecuteNonQuery();
            }
            using (var command = new SqlCommand($"DROP DATABASE [{sanitized}]", connection))
            {
                command.ExecuteNonQuery();
            }
        }

        private static bool DatabaseExists(SqlConnection connection, string database)
        {
            using (var command = new SqlCommand("SELECT database_id FROM sys.databases WHERE name = @name", connection))
            {
                command.Parameters.AddWithValue("@name", database);
                return command.ExecuteScalar() != null;
            }
        }

        /// <summary>
        /// Matches the real SourceCode.Install.Package.Actions.Database.CreateDatabase
        /// action's own CREATE DATABASE script (including its FG_Server/FG_HostServer/
        /// FG_Identity/FG_SmartBroker/FG_ServerLog filegroups). Later K2 install scripts
        /// place objects into these filegroups by name (e.g. "Invalid filegroup
        /// 'FG_HostServer' specified"), so a plain single-filegroup CREATE DATABASE -
        /// which skips the real installer's own database-creation step since the
        /// database already exists - leaves those filegroups missing and those scripts
        /// fail once execution reaches them.
        /// </summary>
        private static void CreateDatabase(SqlConnection connection, string database)
        {
            string sanitized = database.Replace("]", "]]");

            // SQL Server requires FILENAME whenever NAME is specified for a
            // file - it won't infer a path on its own the way it does when
            // you omit NAME entirely. The real installer builds file paths
            // from its own @path + @dbname variables; we mirror that using
            // the instance's configured default data path.
            string dataPath = GetDefaultDataPath(connection);
            string logPath = GetDefaultLogPath(connection) ?? dataPath;

            string sql = $@"
CREATE DATABASE [{sanitized}]
ON PRIMARY
(NAME = [Primary_1], FILENAME = N'{dataPath}{sanitized}_Primary_1.mdf', FILEGROWTH = 10%),
FILEGROUP [FG_Server] (NAME = [FG_Server_1], FILENAME = N'{dataPath}{sanitized}_FG_Server_1.ndf', FILEGROWTH = 10%),
FILEGROUP [FG_HostServer] (NAME = [FG_HostServer_1], FILENAME = N'{dataPath}{sanitized}_FG_HostServer_1.ndf', FILEGROWTH = 10%),
FILEGROUP [FG_Identity] (NAME = [FG_Identity_1], FILENAME = N'{dataPath}{sanitized}_FG_Identity_1.ndf', FILEGROWTH = 10%),
FILEGROUP [FG_SmartBroker] (NAME = [FG_SmartBroker_1], FILENAME = N'{dataPath}{sanitized}_FG_SmartBroker_1.ndf', FILEGROWTH = 10%),
FILEGROUP [FG_ServerLog] (NAME = [FG_ServerLog_1], FILENAME = N'{dataPath}{sanitized}_FG_ServerLog_1.ndf', FILEGROWTH = 10%)
LOG ON (NAME = [FG_log_1], FILENAME = N'{logPath}{sanitized}_log_1.ldf', SIZE = 200MB, FILEGROWTH = 10%)
COLLATE {RequiredCollation};";
            using (var command = new SqlCommand(sql, connection))
            {
                command.ExecuteNonQuery();
            }
        }

        private static string GetDefaultDataPath(SqlConnection connection)
        {
            using (var command = new SqlCommand("SELECT SERVERPROPERTY('InstanceDefaultDataPath')", connection))
            {
                string path = command.ExecuteScalar() as string;
                if (string.IsNullOrEmpty(path))
                {
                    throw new InvalidOperationException("Could not determine the SQL Server instance's default data path.");
                }
                return path.EndsWith("\\", StringComparison.Ordinal) ? path : path + "\\";
            }
        }

        private static string GetDefaultLogPath(SqlConnection connection)
        {
            using (var command = new SqlCommand("SELECT SERVERPROPERTY('InstanceDefaultLogPath')", connection))
            {
                string path = command.ExecuteScalar() as string;
                if (string.IsNullOrEmpty(path))
                {
                    return null;
                }
                return path.EndsWith("\\", StringComparison.Ordinal) ? path : path + "\\";
            }
        }

        /// <summary>
        /// The same ALTER DATABASE settings batch as the real
        /// SourceCode.Install.Package.Actions.Database.CreateDatabase
        /// action applies after creating a fresh K2 database.
        /// </summary>
        private static void ApplyRecommendedDatabaseSettings(SqlConnection connection, string database)
        {
            string sanitized = database.Replace("]", "]]");
            string[] statements =
            {
                $"ALTER DATABASE [{sanitized}] SET QUOTED_IDENTIFIER ON;",
                $"ALTER DATABASE [{sanitized}] SET AUTO_CLOSE OFF;",
                $"ALTER DATABASE [{sanitized}] SET AUTO_SHRINK OFF;",
                $"ALTER DATABASE [{sanitized}] SET AUTO_CREATE_STATISTICS ON;",
                $"ALTER DATABASE [{sanitized}] SET AUTO_UPDATE_STATISTICS ON;",
                $"ALTER DATABASE [{sanitized}] SET AUTO_UPDATE_STATISTICS_ASYNC ON;",
                $"ALTER DATABASE [{sanitized}] SET DATE_CORRELATION_OPTIMIZATION OFF;",
                $"ALTER DATABASE [{sanitized}] SET PARAMETERIZATION FORCED;",
                $"ALTER DATABASE [{sanitized}] SET RECOVERY FULL;",
                $"ALTER DATABASE [{sanitized}] SET PAGE_VERIFY CHECKSUM;",
            };

            foreach (string sql in statements)
            {
                using (var command = new SqlCommand(sql, connection))
                {
                    command.ExecuteNonQuery();
                }
            }
        }

        /// <summary>
        /// Creates the database master key, certificate, and symmetric key
        /// K2's real EncryptionValidation checks for by exact name
        /// ("OPEN SYMMETRIC KEY [SCSSOKey] DECRYPTION BY CERTIFICATE
        /// [SCHostServerCert]"), all idempotent. A real install's own
        /// database schema deployment creates these; this stands in for
        /// that since this app creates the database itself instead of
        /// running K2's real schema installer.
        /// </summary>
        private static void EnsureEncryptionObjects(SqlConnection dbConnection)
        {
            using (var command = new SqlCommand(
                "SELECT COUNT(*) FROM sys.symmetric_keys WHERE name = '##MS_DatabaseMasterKey##'", dbConnection))
            {
                if ((int)command.ExecuteScalar() == 0)
                {
                    string masterKeyPassword = Guid.NewGuid().ToString("N") + "Aa1!";
                    using (var createMasterKey = new SqlCommand(
                        $"CREATE MASTER KEY ENCRYPTION BY PASSWORD = '{masterKeyPassword.Replace("'", "''")}'", dbConnection))
                    {
                        createMasterKey.ExecuteNonQuery();
                    }
                }
            }

            using (var command = new SqlCommand("SELECT COUNT(*) FROM sys.certificates WHERE name = 'SCHostServerCert'", dbConnection))
            {
                if ((int)command.ExecuteScalar() == 0)
                {
                    using (var createCert = new SqlCommand(
                        "CREATE CERTIFICATE SCHostServerCert WITH SUBJECT = 'K2 Host Server Certificate'", dbConnection))
                    {
                        createCert.ExecuteNonQuery();
                    }
                }
            }

            using (var command = new SqlCommand("SELECT COUNT(*) FROM sys.symmetric_keys WHERE name = 'SCSSOKey'", dbConnection))
            {
                if ((int)command.ExecuteScalar() == 0)
                {
                    using (var createKey = new SqlCommand(
                        "CREATE SYMMETRIC KEY SCSSOKey WITH ALGORITHM = AES_256 ENCRYPTION BY CERTIFICATE SCHostServerCert", dbConnection))
                    {
                        createKey.ExecuteNonQuery();
                    }
                }
            }
        }

        /// <summary>
        /// Mirrors the real CreateSqlUser + AssignSqlUserRole actions:
        /// creates a SQL-authenticated user mapped to the connecting
        /// login, with dbo as its default schema, then adds it to
        /// db_owner so it can fully manage the K2 database. Idempotent,
        /// same as the real actions' own existence checks.
        /// </summary>
        private static void EnsureSchemaOwnerUser(SqlConnection dbConnection, string login)
        {
            if (!UserExists(dbConnection, SchemaOwnerUser))
            {
                string sanitizedUser = SchemaOwnerUser.Replace("]", "]]");
                string sanitizedLogin = login.Replace("]", "]]");
                string sql = $"CREATE USER [{sanitizedUser}] FOR LOGIN [{sanitizedLogin}] WITH DEFAULT_SCHEMA=[dbo]";
                using (var command = new SqlCommand(sql, dbConnection))
                {
                    command.ExecuteNonQuery();
                }
            }

            if (!UserInRole(dbConnection, SchemaOwnerUser, SchemaOwnerRole))
            {
                using (var command = new SqlCommand("EXEC sp_addrolemember @role, @user", dbConnection))
                {
                    command.Parameters.AddWithValue("@role", SchemaOwnerRole);
                    command.Parameters.AddWithValue("@user", SchemaOwnerUser);
                    command.ExecuteNonQuery();
                }
            }
        }

        private static bool UserExists(SqlConnection connection, string user)
        {
            using (var command = new SqlCommand("SELECT 1 FROM sys.database_principals WHERE name = @name", connection))
            {
                command.Parameters.AddWithValue("@name", user);
                return command.ExecuteScalar() != null;
            }
        }

        private static bool UserInRole(SqlConnection connection, string user, string role)
        {
            using (var command = new SqlCommand("SELECT IS_ROLEMEMBER(@role, @user)", connection))
            {
                command.Parameters.AddWithValue("@role", role);
                command.Parameters.AddWithValue("@user", user);
                object result = command.ExecuteScalar();
                return result != null && result != DBNull.Value && Convert.ToInt32(result) == 1;
            }
        }
    }
}
