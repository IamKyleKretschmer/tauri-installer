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

        // The real, fixed set of databases a K2 Five install creates,
        // taken from the plaintext documentation block K2HostServer.exe.config
        // ships with ("USE THE SETTINGS BELOW TO REPLACE ENCRYPTED SECTION") -
        // K2 splits its data across 14 separate databases, not one. These
        // names aren't user-configurable in the real product, so they're
        // created as-is regardless of whatever name is in the wizard's
        // "K2 database name" field.
        private static readonly string[] RealK2DatabaseNames =
        {
            "K2Categories",
            "K2Dependencies",
            "K2EnvironmentSettings",
            "K2EventBus",
            "K2EventBusScheduler",
            "K2HostServer",
            "K2Server",
            "K2ServerLog",
            "K2SmartBox",
            "K2SmartBroker",
            "K2SQLUM",
            "K2WebDesigner",
            "K2WebWorkflow",
            "K2Workspace",
        };

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
            // The wizard's "K2 database name" field is kept for backward
            // compatibility and validation, but the real K2 database names
            // (RealK2DatabaseNames) are fixed and not user-configurable, so
            // this value isn't used to name anything created below.

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

                        int createdCount = 0;
                        foreach (string database in RealK2DatabaseNames)
                        {
                            bool alreadyExisted = DatabaseExists(connection, database);
                            if (!alreadyExisted)
                            {
                                CreateDatabase(connection, database);
                                ApplyRecommendedDatabaseSettings(connection, database);
                                createdCount++;
                            }

                            // Schema-owner user + role assignment mirror the real
                            // CreateSqlUser/AssignSqlUserRole actions. Only doable
                            // for SQL authentication, since that's the only mode
                            // where we have a login name to map the user to; for
                            // Windows auth, K2 would use integrated auth instead
                            // and this step is skipped.
                            if (string.Equals(authMode, "sql", StringComparison.OrdinalIgnoreCase))
                            {
                                var dbBuilder = new SqlConnectionStringBuilder(connectionString) { InitialCatalog = database };
                                using (var dbConnection = new SqlConnection(dbBuilder.ConnectionString))
                                {
                                    dbConnection.Open();
                                    EnsureSchemaOwnerUser(dbConnection, username);
                                }
                            }
                        }

                        string userNote = string.Equals(authMode, "sql", StringComparison.OrdinalIgnoreCase)
                            ? $" Schema-owner user '{SchemaOwnerUser}' ensured with '{SchemaOwnerRole}' role in each database."
                            : " Windows authentication: skipped SQL login-based schema-owner user, K2 will use integrated auth.";

                        string dbNote = createdCount == 0
                            ? $"All {RealK2DatabaseNames.Length} K2 databases already exist."
                            : $"Created {createdCount} of {RealK2DatabaseNames.Length} K2 databases with collation {RequiredCollation} (rest already existed).";
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
            // Same as TestConnectionAndDatabase: the real K2 database names
            // are fixed, so args[5] isn't used to name anything dropped here.

            SqlException lastError = null;

            foreach (string connectionString in BuildCandidateConnectionStrings(server, authMode, username, password))
            {
                try
                {
                    using (var connection = new SqlConnection(connectionString))
                    {
                        connection.Open();

                        int droppedCount = 0;
                        foreach (string database in RealK2DatabaseNames)
                        {
                            if (!DatabaseExists(connection, database)) continue;

                            string sanitized = database.Replace("]", "]]");
                            using (var command = new SqlCommand($"ALTER DATABASE [{sanitized}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE", connection))
                            {
                                command.ExecuteNonQuery();
                            }
                            using (var command = new SqlCommand($"DROP DATABASE [{sanitized}]", connection))
                            {
                                command.ExecuteNonQuery();
                            }
                            droppedCount++;
                        }

                        Console.WriteLine(droppedCount == 0
                            ? $"None of the {RealK2DatabaseNames.Length} K2 databases exist on {server}, nothing to drop."
                            : $"Dropped {droppedCount} of {RealK2DatabaseNames.Length} K2 databases from {server}.");
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

        private static bool DatabaseExists(SqlConnection connection, string database)
        {
            using (var command = new SqlCommand("SELECT database_id FROM sys.databases WHERE name = @name", connection))
            {
                command.Parameters.AddWithValue("@name", database);
                return command.ExecuteScalar() != null;
            }
        }

        private static void CreateDatabase(SqlConnection connection, string database)
        {
            string sanitized = database.Replace("]", "]]");
            string sql = $"CREATE DATABASE [{sanitized}] COLLATE {RequiredCollation}";
            using (var command = new SqlCommand(sql, connection))
            {
                command.ExecuteNonQuery();
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
