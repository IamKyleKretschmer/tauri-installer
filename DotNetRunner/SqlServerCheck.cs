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

                        if (DatabaseExists(connection, database))
                        {
                            Console.WriteLine($"Connected to {server}. Database '{database}' already exists.");
                            return 0;
                        }

                        CreateDatabase(connection, database);
                        Console.WriteLine($"Connected to {server}. Database '{database}' created with collation {RequiredCollation}.");
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
    }
}
