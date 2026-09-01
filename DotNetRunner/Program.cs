using System;

namespace DotNetRunner
{
    internal class Program
    {
        private static int Main(string[] args)
        {
            if (args.Length == 0)
            {
                Console.Error.WriteLine("Usage: DotNetRunner.exe <command> [args]");
                return 1;
            }

            switch (args[0])
            {
                case "test-sql":
                    return SqlServerCheck.TestConnectionAndDatabase(args);
                case "drop-database":
                    return SqlServerCheck.DropDatabase(args);
                case "ad-check":
                    return ActiveDirectoryCheck.CheckObjects(args);
                default:
                    Console.WriteLine($"Processed by .NET Framework {Environment.Version}: {args[0]}");
                    return 0;
            }
        }
    }
}
