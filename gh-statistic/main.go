package main

import (
	"context"
	"encoding/csv"
	"fmt"
	"os"
	"time"

	"github.com/shurcooL/githubv4"
	"golang.org/x/oauth2"
)

func main() {
	// Read GitHub personal access token from environment variable
	githubToken := os.Getenv("GITHUB_TOKEN")

	// Read the time from environment variable
	inputStartTime := os.Getenv("START_TIME")
	inputEndTime := os.Getenv("END_TIME")

	var startTime, endTime time.Time
	var err error
	// if the inputStartTime is provided, parse it
	if inputStartTime != "" {
		startTime, err = time.Parse(time.RFC3339, inputStartTime)
		if err != nil {
			fmt.Println(err)
			return
		}
	} else {
		// get the current year
		year := time.Now().Year()
		// create a time object for the start of the year
		startTime = time.Date(year, 1, 1, 0, 0, 0, 0, time.UTC)
	}

	// if the inputEndTime is provided, parse it
	if inputEndTime != "" {
		endTime, err = time.Parse(time.RFC3339, inputEndTime)
		if err != nil {
			fmt.Println(err)
			return
		}
	} else {
		// get the current year
		year := time.Now().Year()
		// create a time object for the start of the year
		endTime = time.Date(year, 12, 31, 23, 59, 59, 0, time.UTC)
	}

	src := oauth2.StaticTokenSource(
		&oauth2.Token{AccessToken: githubToken},
	)
	httpClient := oauth2.NewClient(context.Background(), src)

	client := githubv4.NewClient(httpClient)

	// read users and organizations from CSV file. Row data format: user,organization.
	file, err := os.Open("users.csv")
	if err != nil {
		fmt.Println(err)
		return
	}
	defer file.Close()

	reader := csv.NewReader(file)
	records, err := reader.ReadAll()
	if err != nil {
		fmt.Println(err)
		return
	}

	// create a CSV file to store the results
	outfile, err := os.Create("results.csv")
	if err != nil {
		fmt.Println(err)
		return
	}
	defer outfile.Close()

	writer := csv.NewWriter(outfile)
	defer writer.Flush()

	// write the header row
	err = writer.Write([]string{"User", "Organization", "Total Pull Request Contributions", "Total Pull Request Review Contributions", "Total Issue Contributions"})
	if err != nil {
		fmt.Println(err)
	}

	// for each user and organization, execute the query
	for _, record := range records {
		user, organization := record[0], record[1]

		// get the ID of the organization
		var orgQuery struct {
			Organization struct {
				ID githubv4.ID
			} `graphql:"organization(login: $organizationLogin)"`
		}
		orgVariables := map[string]interface{}{
			"organizationLogin": githubv4.String(organization),
		}
		err := client.Query(context.Background(), &orgQuery, orgVariables)
		if err != nil {
			fmt.Println(err)
			continue
		}

		// get the contributions for the user
		var contribQuery struct {
			User struct {
				ContributionsCollection struct {
					TotalPullRequestContributions       githubv4.Int
					TotalPullRequestReviewContributions githubv4.Int
					TotalIssueContributions             githubv4.Int
				} `graphql:"contributionsCollection(organizationID: $organizationID, from: $startTime, to: $endTime)"`
			} `graphql:"user(login: $userLogin)"`
		}
		contribVariables := map[string]interface{}{
			"userLogin":      githubv4.String(user),
			"organizationID": orgQuery.Organization.ID,
			"startTime":      githubv4.DateTime{Time: startTime}, // "2021-01-01T00:00:00Z
			"endTime":        githubv4.DateTime{Time: endTime},   // "2021-12-31T23:59:59Z
		}
		err = client.Query(context.Background(), &contribQuery, contribVariables)
		if err != nil {
			fmt.Println(err)
			continue
		}

		fmt.Printf("User: %20s, Organization: %16s, ", user, organization)
		fmt.Printf("Total Pull Request Contributions: %3v, ", contribQuery.User.ContributionsCollection.TotalPullRequestContributions)
		fmt.Printf("Total Issue Contributions: %3v, ", contribQuery.User.ContributionsCollection.TotalIssueContributions)
		fmt.Printf("Total Review Contributions: %3v\n", contribQuery.User.ContributionsCollection.TotalPullRequestReviewContributions)

		// write the results to the CSV file
		err = writer.Write([]string{
			user,
			organization,
			fmt.Sprint(contribQuery.User.ContributionsCollection.TotalPullRequestContributions),
			fmt.Sprint(contribQuery.User.ContributionsCollection.TotalPullRequestReviewContributions),
			fmt.Sprint(contribQuery.User.ContributionsCollection.TotalIssueContributions),
		})
		if err != nil {
			fmt.Println(err)
		}
	}
}

