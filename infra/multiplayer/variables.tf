variable "hostname" {
  default = "xwing-mp.amilajack.com"
}
variable "zone_id" {
  default = "Z01849682MODSJLX20QLO"
}
variable "artifact_bucket" {
  type = string
}
variable "artifact_key" {
  default = "releases/current.tar.gz"
}
variable "instance_type" {
  default = "t4g.micro"
}
variable "allowed_origins" {
  type = string
}
variable "acme_email" {
  type = string
}
variable "github_repository" {
  default = "amilajack/xwing-2"
}
variable "github_branch" {
  default = "main"
}
variable "github_oidc_provider_arn" {
  type = string
}
variable "enable_capacity" {
  default = false
}

variable "availability_zone" { default = "us-west-1a" }
